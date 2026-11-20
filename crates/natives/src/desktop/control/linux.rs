//! Event-driven XI2 Escape observation. Wayland has no portable physical-key
//! monitor and uses the host interrupt/native cancellation path instead.
use std::{
	collections::HashMap,
	os::{fd::AsRawFd, unix::net::UnixStream},
	thread::{self, JoinHandle},
};

use x11rb::{
	connection::Connection,
	protocol::{
		Event,
		xinput::{ConnectionExt as _, Device, DeviceType, XIEventMask},
		xkb::{self, ConnectionExt as _, EventType, MapPart},
		xproto::{ConnectionExt as _, Mapping},
	},
	rust_connection::RustConnection,
};

use super::{CancellationReason, CoreResult, DesktopError, EmergencyStop};

pub(super) struct EscapeMonitor {
	stop:   Option<UnixStream>,
	thread: Option<JoinHandle<()>>,
}

impl EscapeMonitor {
	pub(super) fn start(emergency: EmergencyStop) -> CoreResult<Option<Self>> {
		let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
			|| std::env::var("XDG_SESSION_TYPE")
				.is_ok_and(|value| value.eq_ignore_ascii_case("wayland"));
		if wayland {
			return Ok(None);
		}
		Self::start_x11(emergency, None).map(Some)
	}

	pub(super) fn start_x11(emergency: EmergencyStop, display: Option<String>) -> CoreResult<Self> {
		let (stop, stopped) = UnixStream::pair().map_err(failed)?;
		let (ready, receive) = flume::bounded(1);
		let worker = thread::Builder::new()
			.name("desktop-escape".into())
			.spawn(move || {
				let result = X11::new(display.as_deref()).map(|monitor| {
					let _ = ready.send(Ok(()));
					monitor.run(&stopped, &emergency);
				});
				if let Err(error) = result {
					let _ = ready.send(Err(error));
				}
			})
			.map_err(failed)?;
		let monitor = Self { stop: Some(stop), thread: Some(worker) };
		receive.recv().map_err(failed)??;
		Ok(monitor)
	}
}

impl Drop for EscapeMonitor {
	fn drop(&mut self) {
		self.stop.take();
		if let Some(worker) = self.thread.take()
			&& worker.thread().id() != thread::current().id()
		{
			let _ = worker.join();
		}
	}
}

fn failed(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::permission_denied(format!(
		"cannot monitor physical emergency Escape: {error}; no input was authorized"
	))
}

fn poll(descriptors: &mut [libc::pollfd]) -> std::io::Result<()> {
	loop {
		// SAFETY: all descriptors are borrowed live for this blocking call.
		if unsafe { libc::poll(descriptors.as_mut_ptr(), descriptors.len() as libc::nfds_t, -1) } >= 0
		{
			return Ok(());
		}
		let error = std::io::Error::last_os_error();
		if error.kind() != std::io::ErrorKind::Interrupted {
			return Err(error);
		}
	}
}

/// Keep the whole map, not only Escape's row: a real external remap of any
/// key or modifier must still stop the operation.
#[derive(PartialEq, Eq)]
struct KeyboardMap {
	first:                 u8,
	last:                  u8,
	keysyms_per_keycode:   u8,
	keysyms:               Vec<u32>,
	keycodes_per_modifier: u8,
	modifiers:             Vec<u8>,
}

impl KeyboardMap {
	fn read(conn: &RustConnection) -> CoreResult<Self> {
		let setup = conn.setup();
		let mapping = conn
			.get_keyboard_mapping(
				setup.min_keycode,
				setup
					.max_keycode
					.saturating_sub(setup.min_keycode)
					.saturating_add(1),
			)
			.map_err(failed)?
			.reply()
			.map_err(failed)?;
		let modifiers = conn
			.get_modifier_mapping()
			.map_err(failed)?
			.reply()
			.map_err(failed)?;
		Ok(Self {
			first:                 setup.min_keycode,
			last:                  setup.max_keycode,
			keysyms_per_keycode:   mapping.keysyms_per_keycode,
			keysyms:               mapping.keysyms,
			keycodes_per_modifier: modifiers.keycodes_per_modifier(),
			modifiers:             modifiers.keycodes,
		})
	}
}

struct X11 {
	conn:     RustConnection,
	escapes:  HashMap<u16, Option<u8>>,
	keyboard: KeyboardMap,
}
impl X11 {
	fn new(display: Option<&str>) -> CoreResult<Self> {
		let (conn, screen) = x11rb::connect(display).map_err(failed)?;
		// Legacy core clients receive synthetic MappingNotify events when XKB
		// switches its core keyboard to XTEST, even without a keymap write.
		// Identify this monitor as XKB-aware so the server omits that legacy
		// compatibility churn. Subscribe to real XKB map/replacement changes
		// instead, while retaining fail-closed core MappingNotify handling.
		let xkb = conn
			.xkb_use_extension(1, 0)
			.map_err(failed)?
			.reply()
			.map_err(failed)?;
		if !xkb.supported {
			return Err(failed("the X11 server does not support XKB 1.0"));
		}
		let maps = MapPart::KEY_TYPES
			| MapPart::KEY_SYMS
			| MapPart::MODIFIER_MAP
			| MapPart::EXPLICIT_COMPONENTS
			| MapPart::KEY_ACTIONS
			| MapPart::KEY_BEHAVIORS
			| MapPart::VIRTUAL_MODS
			| MapPart::VIRTUAL_MOD_MAP;
		conn
			.xkb_select_events(
				xkb::ID::USE_CORE_KBD.into(),
				EventType::default(),
				EventType::MAP_NOTIFY | EventType::NEW_KEYBOARD_NOTIFY,
				maps,
				maps,
				&xkb::SelectEventsAux::default(),
			)
			.map_err(failed)?
			.check()
			.map_err(failed)?;
		conn
			.xinput_xi_query_version(2, 0)
			.map_err(failed)?
			.reply()
			.map_err(failed)?;
		let setup = conn.setup();
		let mapping = KeyboardMap::read(&conn)?;
		if mapping.keysyms_per_keycode == 0 {
			return Err(failed("the X11 keyboard map is empty"));
		}
		escape_in(setup.min_keycode, mapping.keysyms_per_keycode, &mapping.keysyms)
			.ok_or_else(|| failed("the X11 keymap has no Escape key"))?;
		conn
			.xinput_xi_select_events(setup.roots[screen].root, &[x11rb::protocol::xinput::EventMask {
				deviceid: Device::ALL_MASTER.into(),
				mask:     vec![XIEventMask::RAW_KEY_PRESS],
			}])
			.map_err(failed)?
			.check()
			.map_err(failed)?;
		conn.flush().map_err(failed)?;
		Ok(Self { conn, escapes: HashMap::new(), keyboard: mapping })
	}

	fn run(mut self, stopped: &UnixStream, emergency: &EmergencyStop) {
		let mut descriptors = [
			libc::pollfd { fd: stopped.as_raw_fd(), events: libc::POLLIN, revents: 0 },
			libc::pollfd {
				fd:      self.conn.stream().as_raw_fd(),
				events:  libc::POLLIN,
				revents: 0,
			},
		];
		loop {
			loop {
				let event = match self.conn.poll_for_event() {
					Ok(Some(event)) => event,
					Ok(None) => break,
					Err(_) => {
						emergency.cancel(CancellationReason::ReadFailed);
						return;
					},
				};
				match &event {
					Event::XkbNewKeyboardNotify(event) => {
						// XTEST may replace the core keyboard without changing its map.
						// A real remap or unreadable/replaced device still stops input.
						if event.device_id != event.old_device_id
							|| event.min_key_code != self.keyboard.first
							|| event.max_key_code != self.keyboard.last
						{
							emergency.cancel(CancellationReason::MappingNotify);
							return;
						}
						match KeyboardMap::read(&self.conn) {
							Ok(mapping) if mapping == self.keyboard => self.escapes.clear(),
							Ok(_) => {
								emergency.cancel(CancellationReason::MappingNotify);
								return;
							},
							Err(_) => {
								emergency.cancel(CancellationReason::DeviceQueryFailed);
								return;
							},
						}
					},
					Event::XkbMapNotify(_) | Event::MappingNotify(_) => {
						emergency.cancel(CancellationReason::MappingNotify);
						return;
					},
					_ => {},
				}
				match step(&mut self.escapes, &event, |device| device_escape(&self.conn, device)) {
					Step::Next => {},
					Step::Escape(source) => {
						let devices = self
							.conn
							.xinput_xi_query_device(source)
							.ok()
							.and_then(|cookie| cookie.reply().ok());
						let Some(devices) = devices else {
							emergency.cancel(CancellationReason::DeviceQueryFailed);
							return;
						};
						if devices.infos.iter().any(|device| {
							let name = String::from_utf8_lossy(&device.name);
							device.type_ == DeviceType::SLAVE_KEYBOARD
								&& !name.contains("XTEST")
								&& !name.starts_with("OMP MPX ")
						}) {
							emergency.escape();
						}
					},
					Step::Stop => {
						emergency.cancel(CancellationReason::DeviceQueryFailed);
						return;
					},
				}
			}
			if poll(&mut descriptors).is_err() {
				emergency.cancel(CancellationReason::PollFailed);
				return;
			}
			if descriptors[0].revents != 0 {
				return;
			}
			if descriptors[1].revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
				emergency.cancel(CancellationReason::PollFailed);
				return;
			}
		}
	}
}

/// What the monitor does with one X event.
enum Step {
	Next,
	/// The Escape keycode was pressed on this source device.
	Escape(u16),
	Stop,
}

/// A raw press reports its keycode in the source device's keymap, so Escape
/// is looked up there: the core keymap follows whichever device typed last,
/// and takeover's next XTEST key can switch it before a user's press is read.
/// `read` reads a device's Escape keycode; failing to read it stops.
fn step(
	escapes: &mut HashMap<u16, Option<u8>>,
	event: &Event,
	read: impl FnOnce(u16) -> CoreResult<Option<u8>>,
) -> Step {
	match event {
		Event::XinputRawKeyPress(event) => {
			let escape = match escapes.get(&event.sourceid) {
				Some(&escape) => escape,
				None => match read(event.sourceid) {
					Ok(escape) => *escapes.entry(event.sourceid).or_insert(escape),
					Err(_) => return Step::Stop,
				},
			};
			if escape.is_some_and(|escape| event.detail == u32::from(escape)) {
				Step::Escape(event.sourceid)
			} else {
				Step::Next
			}
		},
		// Xorg sends the core keymap again each time the core keyboard switches
		// source device, as the takeover's own first XTEST key does after the
		// user typed; a device's own keymap may have changed with it.
		Event::MappingNotify(event) if event.request == Mapping::KEYBOARD => {
			escapes.clear();
			Step::Next
		},
		_ => Step::Next,
	}
}

/// The Escape keycode of `device`'s own keymap, `None` when it has none.
fn device_escape(conn: &RustConnection, device: u16) -> CoreResult<Option<u8>> {
	let setup = conn.setup();
	let mapping = conn
		.xinput_get_device_key_mapping(
			u8::try_from(device).map_err(failed)?,
			setup.min_keycode,
			setup
				.max_keycode
				.saturating_sub(setup.min_keycode)
				.saturating_add(1),
		)
		.map_err(failed)?
		.reply()
		.map_err(failed)?;
	Ok(escape_in(setup.min_keycode, mapping.keysyms_per_keycode, &mapping.keysyms))
}

fn escape_in(min_keycode: u8, keysyms_per_keycode: u8, keysyms: &[u32]) -> Option<u8> {
	let width = usize::from(keysyms_per_keycode);
	if width == 0 {
		return None;
	}
	keysyms
		.chunks(width)
		.position(|row| row.contains(&0xff1b))
		.and_then(|row| min_keycode.checked_add(u8::try_from(row).ok()?))
}

#[cfg(test)]
mod tests {
	use x11rb::protocol::{xinput::RawKeyPressEvent, xproto::MappingNotifyEvent};

	use super::*;

	#[test]
	fn escape_is_read_in_the_pressing_devices_keymap() {
		let press = |sourceid, detail| {
			Event::XinputRawKeyPress(RawKeyPressEvent { detail, sourceid, ..Default::default() })
		};
		let keyboard = Event::MappingNotify(MappingNotifyEvent {
			request: Mapping::KEYBOARD,
			..Default::default()
		});
		// The user's keyboard (8) puts Escape on 9, XTEST (4) on 66.
		let keymaps = |device| Ok(Some(if device == 8 { 9 } else { 66 }));
		let unreadable = |_| Err(failed("no keymap"));
		let mut escapes = HashMap::new();

		assert!(matches!(step(&mut escapes, &press(4, 66), keymaps), Step::Escape(4)));
		assert!(matches!(step(&mut escapes, &keyboard, keymaps), Step::Next));
		assert!(matches!(step(&mut escapes, &press(8, 9), keymaps), Step::Escape(8)));
		assert!(matches!(step(&mut escapes, &press(8, 66), unreadable), Step::Next), "cached");
		assert!(matches!(step(&mut escapes, &keyboard, unreadable), Step::Next));
		assert!(matches!(step(&mut escapes, &press(8, 9), |_| Ok(None)), Step::Next));
		assert!(matches!(step(&mut escapes, &keyboard, unreadable), Step::Next));
		assert!(matches!(step(&mut escapes, &press(8, 9), unreadable), Step::Stop));
	}
}
