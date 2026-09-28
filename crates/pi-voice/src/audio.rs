//! Cross-platform microphone capture and streaming speaker playback.
//!
//! The per-platform backends in [`crate::device`] own device access, format
//! conversion, channel mixing, and resampling. The engine exposes one stable
//! mono `f32` contract: the N-API classes in pi-natives adapt it to
//! TypeScript, and [`crate::live`] shares [`PlaybackStream`] for remote-audio
//! rendering.

use std::{
	collections::VecDeque,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU32, Ordering},
	},
	time::Duration,
};

use parking_lot::Mutex;
use tokio::sync::Notify;

use crate::{
	VoiceResult,
	device::{CaptureDevice, DeviceConfig, PlaybackDevice, playback_drain_periods},
};

// PulseAudio TCP playback stutters with a 20 ms target buffer; 50 ms absorbs
// transport jitter while preserving interactive latency.
#[cfg(target_os = "linux")]
const PLAYBACK_PERIOD_MS: u32 = 50;
#[cfg(not(target_os = "linux"))]
const PLAYBACK_PERIOD_MS: u32 = 20;
#[cfg(target_os = "linux")]
const CAPTURE_PERIOD_MS: u32 = 50;
#[cfg(not(target_os = "linux"))]
const CAPTURE_PERIOD_MS: u32 = 20;
// Backends queue up to `device::playback_drain_periods` periods (three for
// AudioQueue buffers/WASAPI padding; PulseAudio scales this with the widened
// remote/`PULSE_LATENCY_MSEC` backlog — see that function). Draining needs
// that many silence periods COMMITTED to the OS behind the tail: once the
// last is accepted into the backend's FIFO, everything ahead of it has
// played. The callback that marks drained races teardown — on Linux the
// delivery gate may cancel that callback's own write after `wait_for_drain`
// wakes — so count one extra empty callback: the racy, possibly-uncommitted
// write is always the last one, which is margin rather than accounted flush.
const PLAYBACK_DRAIN_MARGIN_CALLBACKS: usize = 1;
/// Speaker backlog past which the oldest queued audio is dropped so playback
/// catches up to live. Two seconds absorbs a decode burst without letting a
/// stalled playout lag the conversation. The bound is on the queue the decoder
/// feeds, not the OS device buffer.
const PLAYBACK_QUEUE_BOUND: Duration = Duration::from_secs(2);

/// Queued speaker audio and how much has been dropped to stay near the bound.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PlaybackQueueStats {
	pub queued_ms:  u32,
	pub dropped_ms: u32,
}

#[derive(Debug)]
enum PlaybackRecv {
	Empty,
	Disconnected,
}

struct PlaybackQueueInner {
	chunks:          VecDeque<Vec<f32>>,
	queued_samples:  usize,
	dropped_samples: u64,
	senders:         usize,
}

/// Shared playback queue. `write` never waits for the speaker: when the queued
/// duration exceeds [`PLAYBACK_QUEUE_BOUND`], the oldest chunks are discarded
/// and the newest audio stays. The render callback and the decoder share one
/// short mutex; neither waits for playout.
struct PlaybackQueue {
	inner:         Mutex<PlaybackQueueInner>,
	sample_rate:   u32,
	bound_samples: usize,
}

impl PlaybackQueue {
	fn new(sample_rate: u32) -> Self {
		let bound_samples =
			(u64::from(sample_rate) * PLAYBACK_QUEUE_BOUND.as_millis() as u64 / 1_000) as usize;
		Self {
			inner: Mutex::new(PlaybackQueueInner {
				chunks:          VecDeque::new(),
				queued_samples:  0,
				dropped_samples: 0,
				senders:         0,
			}),
			sample_rate,
			bound_samples,
		}
	}

	fn retain_sender(&self) {
		self.inner.lock().senders += 1;
	}

	fn release_sender(&self) {
		let mut inner = self.inner.lock();
		inner.senders = inner.senders.saturating_sub(1);
	}

	/// Queue `samples`, dropping the oldest audio until the backlog is within
	/// the bound. Returns false when every producer has already been dropped.
	/// A single newest chunk larger than the bound is kept: catch-up must not
	/// discard the audio that just arrived.
	fn push(&self, samples: &[f32]) -> bool {
		if samples.is_empty() {
			return true;
		}
		let mut inner = self.inner.lock();
		if inner.senders == 0 {
			return false;
		}
		let mut queued = inner.queued_samples + samples.len();
		inner.chunks.push_back(samples.to_vec());
		while queued > self.bound_samples && inner.chunks.len() > 1 {
			let Some(old) = inner.chunks.pop_front() else {
				break;
			};
			queued -= old.len();
			inner.dropped_samples += old.len() as u64;
		}
		inner.queued_samples = queued;
		true
	}

	fn try_pop(&self) -> Result<Vec<f32>, PlaybackRecv> {
		let mut inner = self.inner.lock();
		if let Some(chunk) = inner.chunks.pop_front() {
			inner.queued_samples -= chunk.len();
			return Ok(chunk);
		}
		if inner.senders == 0 {
			Err(PlaybackRecv::Disconnected)
		} else {
			Err(PlaybackRecv::Empty)
		}
	}

	fn stats(&self) -> PlaybackQueueStats {
		let inner = self.inner.lock();
		PlaybackQueueStats {
			queued_ms:  samples_to_ms(inner.queued_samples as u64, self.sample_rate),
			dropped_ms: samples_to_ms(inner.dropped_samples, self.sample_rate),
		}
	}
}

fn samples_to_ms(samples: u64, sample_rate: u32) -> u32 {
	if sample_rate == 0 {
		return 0;
	}
	u32::try_from(samples.saturating_mul(1_000) / u64::from(sample_rate)).unwrap_or(u32::MAX)
}

/// Shared render-time state for one playback device: gain, drain, stop.
///
/// Held as an `Arc` by both the stream and its N-API wrapper so
/// [`PlaybackState::wait_for_drain`] can outlive the stream lock.
pub struct PlaybackState {
	gain_bits: AtomicU32,
	drained:   AtomicBool,
	stopped:   AtomicBool,
	notify:    Notify,
}

impl PlaybackState {
	fn new() -> Self {
		Self {
			gain_bits: AtomicU32::new(1.0f32.to_bits()),
			drained:   AtomicBool::new(false),
			stopped:   AtomicBool::new(false),
			notify:    Notify::new(),
		}
	}

	fn gain(&self) -> f32 {
		f32::from_bits(self.gain_bits.load(Ordering::Acquire))
	}

	fn set_gain(&self, gain: f32) {
		self.gain_bits.store(gain.to_bits(), Ordering::Release);
	}

	fn mark_drained(&self) {
		if !self.drained.swap(true, Ordering::AcqRel) {
			self.notify.notify_waiters();
		}
	}

	fn mark_stopped(&self) {
		self.stopped.store(true, Ordering::Release);
		self.notify.notify_waiters();
	}

	/// Resolve once every queued sample reached the speaker (or the stream
	/// stopped). Used by the N-API `AudioPlayback.end()` graceful-close path.
	pub async fn wait_for_drain(&self) {
		loop {
			let notified = self.notify.notified();
			if self.drained.load(Ordering::Acquire) || self.stopped.load(Ordering::Acquire) {
				return;
			}
			notified.await;
		}
	}
}

/// Wakes drain waiters when the backend drops the fill callback (device loss
/// or stop) so `wait_for_drain` can never outlive the render path.
struct FillGuard {
	state: Arc<PlaybackState>,
}

impl Drop for FillGuard {
	fn drop(&mut self) {
		self.state.mark_stopped();
	}
}

/// Producer endpoint for one native playback device. Cloned into the WebRTC
/// remote-audio decoder so it can feed the same speaker stream.
pub struct PlaybackWriter {
	queue: Arc<PlaybackQueue>,
	state: Arc<PlaybackState>,
}

impl PlaybackWriter {
	fn new(queue: Arc<PlaybackQueue>, state: Arc<PlaybackState>) -> Self {
		queue.retain_sender();
		Self { queue, state }
	}

	/// Queue mono floating-point samples without blocking the caller. Audio
	/// past the playback bound is dropped from the front of the queue; this
	/// never waits for the speaker and never fails because the queue is full.
	pub fn write(&self, samples: &[f32]) -> VoiceResult<()> {
		if samples.is_empty() {
			return Ok(());
		}
		if self.state.stopped.load(Ordering::Acquire) || self.state.drained.load(Ordering::Acquire) {
			return Err("Native audio playback is closed".to_owned());
		}
		if self.queue.push(samples) {
			Ok(())
		} else {
			Err("Native audio playback is closed".to_owned())
		}
	}
}

impl Clone for PlaybackWriter {
	fn clone(&self) -> Self {
		self.queue.retain_sender();
		Self { queue: Arc::clone(&self.queue), state: Arc::clone(&self.state) }
	}
}

impl Drop for PlaybackWriter {
	fn drop(&mut self) {
		self.queue.release_sender();
	}
}

/// Running mono playback stream shared by N-API playback and native WebRTC.
pub struct PlaybackStream {
	device: Option<PlaybackDevice>,
	writer: Option<PlaybackWriter>,
	state:  Arc<PlaybackState>,
	queue:  Arc<PlaybackQueue>,
}

impl PlaybackStream {
	/// Open and start the default speaker at the requested logical sample rate.
	pub fn start(sample_rate: u32) -> VoiceResult<Self> {
		let sample_rate = audio_sample_rate(sample_rate)?;
		let state = Arc::new(PlaybackState::new());
		let queue = Arc::new(PlaybackQueue::new(sample_rate));
		let callback_state = Arc::clone(&state);
		let callback_queue = Arc::clone(&queue);
		let mut current = Vec::new();
		let mut cursor = 0;
		let mut empty_callbacks = 0;
		let config = DeviceConfig { sample_rate, period_ms: PLAYBACK_PERIOD_MS };
		let drain_callbacks =
			(playback_drain_periods(config) as usize) + PLAYBACK_DRAIN_MARGIN_CALLBACKS;
		// The guard travels inside the fill closure: if the backend drops the
		// callback for any reason (worker exit on device loss, stop), waiters
		// blocked in `wait_for_drain` wake instead of hanging forever.
		let guard = FillGuard { state: Arc::clone(&state) };
		let device = PlaybackDevice::start(
			config,
			Box::new(move |output| {
				let _ = &guard;
				fill_playback(
					&callback_queue,
					&mut current,
					&mut cursor,
					output,
					&callback_state,
					&mut empty_callbacks,
					drain_callbacks,
				);
			}),
		)
		.map_err(|error| format!("Failed to open the default speaker: {error}"))?;

		Ok(Self {
			device: Some(device),
			writer: Some(PlaybackWriter::new(Arc::clone(&queue), Arc::clone(&state))),
			state,
			queue,
		})
	}

	/// Clone the producer endpoint used by the remote-audio decoder.
	pub fn writer(&self) -> VoiceResult<PlaybackWriter> {
		self
			.writer
			.clone()
			.ok_or_else(|| "Native audio playback is closed".to_owned())
	}

	/// Shared render-time state, cloned out so callers can await drain after
	/// releasing the stream lock.
	pub fn state(&self) -> Arc<PlaybackState> {
		Arc::clone(&self.state)
	}

	/// Queued speaker duration and audio dropped to stay near the bound.
	pub fn queue_stats(&self) -> PlaybackQueueStats {
		self.queue.stats()
	}

	/// Close the producer side so the render callback can detect drain.
	pub fn finish_input(&mut self) {
		self.writer.take();
	}

	/// Scale audio at render time so gain changes affect already queued
	/// samples. Rejects non-finite gains; negative gains clamp to silence.
	pub fn set_gain(&self, gain: f32) -> VoiceResult<()> {
		if !gain.is_finite() {
			return Err("Audio playback gain must be finite".to_owned());
		}
		self.state.set_gain(gain.max(0.0));
		Ok(())
	}

	/// Stop playback immediately and release the default speaker.
	pub fn stop(&mut self) -> VoiceResult<()> {
		self.writer.take();
		self.state.mark_stopped();
		let Some(mut device) = self.device.take() else {
			return Ok(());
		};
		device.stop()
	}
}

impl Drop for PlaybackStream {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}

/// Bounds the logical rate to what OS converters accept before device open.
fn audio_sample_rate(sample_rate: u32) -> VoiceResult<u32> {
	if !(8_000..=384_000).contains(&sample_rate) {
		return Err(format!("Unsupported audio sample rate {sample_rate}"));
	}
	Ok(sample_rate)
}

fn fill_playback(
	queue: &PlaybackQueue,
	current: &mut Vec<f32>,
	cursor: &mut usize,
	output: &mut [f32],
	state: &PlaybackState,
	empty_callbacks: &mut usize,
	drain_callbacks: usize,
) {
	output.fill(0.0);
	if state.stopped.load(Ordering::Acquire) {
		return;
	}

	let gain = state.gain();
	let mut output_offset = 0;
	while output_offset < output.len() {
		if *cursor == current.len() {
			match queue.try_pop() {
				Ok(next) => {
					*current = next;
					*cursor = 0;
					*empty_callbacks = 0;
				},
				Err(PlaybackRecv::Empty) => {
					*empty_callbacks = 0;
					break;
				},
				Err(PlaybackRecv::Disconnected) => {
					*empty_callbacks += 1;
					if *empty_callbacks >= drain_callbacks {
						state.mark_drained();
					}
					break;
				},
			}
		}

		let count = (current.len() - *cursor).min(output.len() - output_offset);
		let source = &current[*cursor..*cursor + count];
		let destination = &mut output[output_offset..output_offset + count];
		if gain == 1.0 {
			destination.copy_from_slice(source);
		} else {
			for (destination, source) in destination.iter_mut().zip(source) {
				*destination = *source * gain;
			}
		}
		*cursor += count;
		output_offset += count;
	}
}

/// Running default-microphone capture delivering low-latency mono `f32`
/// chunks to its callback. Wraps the platform device so N-API callers never
/// see backend types.
pub struct CaptureStream {
	device: Option<CaptureDevice>,
}

impl CaptureStream {
	/// Open the default microphone at the requested sample rate. `on_audio`
	/// runs on the realtime audio thread — it must not block.
	pub fn start<C>(sample_rate: u32, mut on_audio: C) -> VoiceResult<Self>
	where
		C: FnMut(&[f32]) + Send + 'static,
	{
		let sample_rate = audio_sample_rate(sample_rate)?;
		let config = DeviceConfig { sample_rate, period_ms: CAPTURE_PERIOD_MS };
		let device = CaptureDevice::start(
			config,
			Box::new(move |samples| {
				if !samples.is_empty() {
					on_audio(samples);
				}
			}),
		)
		.map_err(|error| format!("Failed to open the default microphone: {error}"))?;
		Ok(Self { device: Some(device) })
	}

	/// Stop capture immediately and release the microphone.
	pub fn stop(&mut self) -> VoiceResult<()> {
		let Some(mut device) = self.device.take() else {
			return Ok(());
		};
		device.stop()
	}
}

impl Drop for CaptureStream {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}

#[cfg(test)]
mod tests {
	use std::{
		env,
		mem::forget,
		sync::atomic::AtomicUsize,
		thread::sleep,
		time::{Duration, Instant},
	};

	use super::*;

	// Base three-period assumption (`PULSE_BACKLOG_PERIODS` on Linux; fixed
	// for other backends) plus the one callback of teardown-race margin
	// (`PLAYBACK_DRAIN_MARGIN_CALLBACKS`) — what every backend uses for a
	// period-sized local target.
	const LOCAL_DRAIN_CALLBACKS: usize = 3 + PLAYBACK_DRAIN_MARGIN_CALLBACKS;

	fn disconnected_queue(state: &Arc<PlaybackState>, chunks: &[Vec<f32>]) -> Arc<PlaybackQueue> {
		let queue = Arc::new(PlaybackQueue::new(48_000));
		let writer = PlaybackWriter::new(Arc::clone(&queue), Arc::clone(state));
		for chunk in chunks {
			writer.write(chunk).expect("queue accepts audio");
		}
		drop(writer);
		queue
	}

	#[test]
	fn playback_preserves_chunk_order_and_applies_render_gain() {
		let state = Arc::new(PlaybackState::new());
		state.set_gain(0.5);
		let queue = disconnected_queue(&state, &[vec![1.0, -1.0], vec![0.5, -0.5]]);
		let mut current = Vec::new();
		let mut cursor = 0;
		let mut empty_callbacks = 0;
		let mut output = [9.0; 5];

		fill_playback(
			&queue,
			&mut current,
			&mut cursor,
			&mut output,
			&state,
			&mut empty_callbacks,
			LOCAL_DRAIN_CALLBACKS,
		);

		assert_eq!(output, [0.5, -0.5, 0.25, -0.25, 0.0]);
		assert!(!state.drained.load(Ordering::Acquire));
		let mut silence = [1.0; 2];
		while empty_callbacks < LOCAL_DRAIN_CALLBACKS {
			silence.fill(1.0);
			fill_playback(
				&queue,
				&mut current,
				&mut cursor,
				&mut silence,
				&state,
				&mut empty_callbacks,
				LOCAL_DRAIN_CALLBACKS,
			);
			assert_eq!(silence, [0.0, 0.0]);
			assert_eq!(
				state.drained.load(Ordering::Acquire),
				empty_callbacks >= LOCAL_DRAIN_CALLBACKS
			);
		}
	}

	/// Regression guard: a widened playback backlog (remote `PULSE_SERVER` or
	/// `PULSE_LATENCY_MSEC`) must not be declared drained after only the
	/// local three-period margin — queued audio would still be flushing to
	/// the speaker and `AudioPlayback.end()` would clip it. Draining must
	/// wait out the full widened `drain_callbacks` count.
	#[test]
	fn widened_backlog_is_not_drained_within_local_margin() {
		let state = Arc::new(PlaybackState::new());
		let queue = disconnected_queue(&state, &[]);
		let mut current = Vec::new();
		let mut cursor = 0;
		let mut empty_callbacks = 0;
		let mut output = [0.0; 2];
		let widened_drain_callbacks = LOCAL_DRAIN_CALLBACKS * 4;

		for _ in 0..LOCAL_DRAIN_CALLBACKS {
			fill_playback(
				&queue,
				&mut current,
				&mut cursor,
				&mut output,
				&state,
				&mut empty_callbacks,
				widened_drain_callbacks,
			);
		}
		assert!(
			!state.drained.load(Ordering::Acquire),
			"drained after only the local margin despite a widened backlog"
		);

		while empty_callbacks < widened_drain_callbacks {
			fill_playback(
				&queue,
				&mut current,
				&mut cursor,
				&mut output,
				&state,
				&mut empty_callbacks,
				widened_drain_callbacks,
			);
		}
		assert!(state.drained.load(Ordering::Acquire));
	}

	/// Past ~2 s of queued audio, the oldest chunks are dropped and the newest
	/// stay. `write` returns immediately so the decoder is never blocked, and
	/// the stats report both the remaining depth and the dropped duration.
	#[test]
	fn playback_queue_drops_oldest_past_bound_and_reports_depth() {
		let rate = 48_000u32;
		let state = Arc::new(PlaybackState::new());
		let queue = Arc::new(PlaybackQueue::new(rate));
		let writer = PlaybackWriter::new(Arc::clone(&queue), Arc::clone(&state));
		let one_second = rate as usize;
		writer
			.write(&vec![1.0; one_second])
			.expect("overflow drops oldest instead of failing the decoder");
		writer
			.write(&vec![2.0; one_second])
			.expect("second second queues");
		writer
			.write(&vec![3.0; one_second])
			.expect("third second drops the oldest and still returns");

		let stats = queue.stats();
		assert_eq!(stats.queued_ms, 2_000, "depth stays at the bound");
		assert_eq!(stats.dropped_ms, 1_000, "the oldest second was dropped");

		let first = queue.try_pop().expect("newest-but-one second remains");
		let second = queue.try_pop().expect("newest second remains");
		assert!(first.iter().all(|sample| *sample == 2.0), "oldest audio was dropped");
		assert!(second.iter().all(|sample| *sample == 3.0), "newest audio was kept");
		assert!(queue.try_pop().is_err(), "nothing older remains queued");

		let after = queue.stats();
		assert_eq!(after.queued_ms, 0);
		assert_eq!(after.dropped_ms, 1_000, "drops stay reported after playout");
	}

	#[test]
	fn opt_in_default_playback_initializes_and_stops() {
		if env::var_os("OMP_NATIVE_AUDIO_PLAYBACK_TEST").is_none() {
			return;
		}

		let mut stream = PlaybackStream::start(16_000).expect("default playback device starts");
		stream.stop().expect("default playback device stops");
	}

	#[test]
	fn opt_in_default_capture_receives_frames() {
		if env::var_os("OMP_NATIVE_AUDIO_CAPTURE_TEST").is_none() {
			return;
		}

		let callbacks = Arc::new(AtomicUsize::new(0));
		let callback_count = Arc::clone(&callbacks);
		let mut stream = CaptureStream::start(16_000, move |_samples| {
			callback_count.fetch_add(1, Ordering::Relaxed);
		})
		.expect("default capture device starts");

		let deadline = Instant::now() + Duration::from_secs(5);
		while callbacks.load(Ordering::Relaxed) == 0 && Instant::now() < deadline {
			sleep(Duration::from_millis(20));
		}
		if callbacks.load(Ordering::Relaxed) == 0 {
			forget(stream);
			panic!("capture device started but delivered no frames within five seconds");
		}
		stream.stop().expect("capture device stops");
	}
}
