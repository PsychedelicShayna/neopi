//! Read-only journal counts without materializing message bodies.

use std::{
	fmt,
	fs::File,
	io::{BufRead, BufReader, Read},
};

use napi::Error;
use napi_derive::napi;
use serde::{
	Deserialize, Deserializer,
	de::{IgnoredAny, MapAccess, SeqAccess, Visitor},
};

use crate::task;

#[derive(Deserialize)]
#[serde(field_identifier, rename_all = "lowercase")]
enum Field {
	Type,
	Message,
	#[serde(other)]
	Other,
}

#[derive(Clone, Copy, PartialEq)]
enum ValueKind {
	Message,
	Object,
	Other,
}

impl<'de> Deserialize<'de> for ValueKind {
	fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		struct KindVisitor;
		impl<'de> Visitor<'de> for KindVisitor {
			type Value = ValueKind;

			fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
				formatter.write_str("a JSON value")
			}

			fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
				Ok(if value == "message" {
					ValueKind::Message
				} else {
					ValueKind::Other
				})
			}

			fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
				while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
				Ok(ValueKind::Object)
			}

			fn visit_seq<S: SeqAccess<'de>>(self, mut seq: S) -> Result<Self::Value, S::Error> {
				while seq.next_element::<IgnoredAny>()?.is_some() {}
				Ok(ValueKind::Other)
			}

			fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
				Ok(ValueKind::Other)
			}

			fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E> {
				Ok(ValueKind::Other)
			}

			fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E> {
				Ok(ValueKind::Other)
			}

			fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E> {
				Ok(ValueKind::Other)
			}

			fn visit_unit<E>(self) -> Result<Self::Value, E> {
				Ok(ValueKind::Other)
			}
		}
		deserializer.deserialize_any(KindVisitor)
	}
}

struct MessageRecord(bool);

impl<'de> Deserialize<'de> for MessageRecord {
	fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		struct RecordVisitor;
		impl<'de> Visitor<'de> for RecordVisitor {
			type Value = MessageRecord;

			fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
				formatter.write_str("a journal object")
			}

			fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
				let mut kind = ValueKind::Other;
				let mut message = ValueKind::Other;
				while let Some(field) = map.next_key::<Field>()? {
					match field {
						Field::Type => kind = map.next_value()?,
						Field::Message => message = map.next_value()?,
						Field::Other => {
							map.next_value::<IgnoredAny>()?;
						},
					}
				}
				// Last keys win, as in the JSON parser used by session loading.
				Ok(MessageRecord(kind == ValueKind::Message && message == ValueKind::Object))
			}
		}
		deserializer.deserialize_map(RecordVisitor)
	}
}

fn is_message_record(line: &[u8]) -> bool {
	serde_json::from_slice::<MessageRecord>(line).is_ok_and(|record| record.0)
}

fn count_records(mut reader: impl BufRead) -> std::io::Result<u64> {
	let mut count = 0;
	let mut partial = Vec::new();
	loop {
		let bytes = reader.fill_buf()?;
		if bytes.is_empty() {
			// Accept a complete final record without a newline, not a truncated
			// JSON value.
			return Ok(count + u64::from(is_message_record(&partial)));
		}
		let mut start = 0;
		for end in memchr::memchr_iter(b'\n', bytes) {
			let line = &bytes[start..end];
			if partial.is_empty() {
				count += u64::from(is_message_record(line));
			} else {
				partial.extend_from_slice(line);
				count += u64::from(is_message_record(&partial));
				partial.clear();
			}
			start = end + 1;
		}
		partial.extend_from_slice(&bytes[start..]);
		let consumed = bytes.len();
		reader.consume(consumed);
	}
}

/// Count valid top-level message entries in a file prefix without loading blobs
/// or taking a writer lease. Includes tool results and alternate branches.
/// Malformed records are skipped.
#[napi]
pub fn count_session_messages(path: String, max_bytes: f64) -> task::Promise<f64> {
	task::blocking("count_session_messages", (), move |_| {
		if !max_bytes.is_finite()
			|| max_bytes < 0.0
			|| max_bytes.fract() != 0.0
			|| max_bytes > 9_007_199_254_740_991.0
		{
			return Err(Error::from_reason("maxBytes must be a nonnegative safe integer"));
		}
		let file = File::open(&path)
			.map_err(|err| Error::from_reason(format!("Cannot open journal: {err}")))?;
		let reader = BufReader::with_capacity(64 * 1024, file.take(max_bytes as u64));
		count_records(reader)
			.map(|count| count as f64)
			.map_err(|err| Error::from_reason(format!("Cannot read journal: {err}")))
	})
}
