// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::io::{ErrorKind, Read, Write};

const KIB: usize = 1024;
const MIB: usize = 1024 * KIB;

/// Contract §5 "Private/reply frame": the bound of every pipe frame length header.
pub const PIPE_FRAME_BYTES: usize = 16 * MIB;
/// Contract §5 "Incoming public request": the bound of the encoded renderer envelope. Feature 005 contract Δ5 raises it to 2 MiB.
pub const PUBLIC_REQUEST_BYTES: usize = 2 * MIB;
/// `{"kind":"public","request":` and `}` add 28 bytes to the envelope (contract §5).
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "only tests check the frame body bound")
)]
pub const PUBLIC_FRAME_BODY_BYTES: usize = PUBLIC_REQUEST_BYTES + 28;

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    /// A length or an envelope above its bound. The code is `FRAME_LIMIT`.
    FrameLimit,
    /// The body is not UTF-8. The code is `INVALID_REQUEST`.
    InvalidUtf8,
    /// The stream ended inside a length header or a body.
    Truncated,
    Io(std::io::ErrorKind),
}

/// Reads one frame: a four-byte unsigned little-endian length and a UTF-8 body. A clean end of stream before a header gives `None`.
pub fn read_frame(reader: &mut impl Read) -> Result<Option<String>, FrameError> {
    let mut header = [0u8; 4];
    let mut filled = 0;
    while filled < header.len() {
        match reader.read(&mut header[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => return Err(FrameError::Truncated),
            Ok(n) => filled += n,
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => return Err(FrameError::Io(error.kind())),
        }
    }
    let length = u32::from_le_bytes(header) as usize;
    if length > PIPE_FRAME_BYTES {
        return Err(FrameError::FrameLimit);
    }
    let mut body = vec![0u8; length];
    reader
        .read_exact(&mut body)
        .map_err(|error| match error.kind() {
            ErrorKind::UnexpectedEof => FrameError::Truncated,
            kind => FrameError::Io(kind),
        })?;
    String::from_utf8(body)
        .map(Some)
        .map_err(|_| FrameError::InvalidUtf8)
}

pub fn write_frame(writer: &mut impl Write, body: &str) -> Result<(), FrameError> {
    if body.len() > PIPE_FRAME_BYTES {
        return Err(FrameError::FrameLimit);
    }
    let io = |error: std::io::Error| FrameError::Io(error.kind());
    writer
        .write_all(&(body.len() as u32).to_le_bytes())
        .map_err(io)?;
    writer.write_all(body.as_bytes()).map_err(io)?;
    writer.flush().map_err(io)
}

/// Wraps an encoded renderer envelope into the body `{"kind":"public","request":<envelope>}`.
pub fn public_request_body(envelope: &str) -> Result<String, FrameError> {
    if envelope.len() > PUBLIC_REQUEST_BYTES {
        return Err(FrameError::FrameLimit);
    }
    Ok(format!("{{\"kind\":\"public\",\"request\":{envelope}}}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::Cursor;

    fn frame(body: &[u8]) -> Vec<u8> {
        let mut bytes = (body.len() as u32).to_le_bytes().to_vec();
        bytes.extend_from_slice(body);
        bytes
    }

    /// Counts the bytes that the reader under test takes. It supplies `header`, then an endless body.
    struct Counting {
        header: [u8; 4],
        taken: usize,
    }

    impl Read for Counting {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = buf.len().min(64);
            for (i, byte) in buf[..n].iter_mut().enumerate() {
                *byte = self.header.get(self.taken + i).copied().unwrap_or(b' ');
            }
            self.taken += n;
            Ok(n)
        }
    }

    #[test]
    fn origin() {
        println!("ORIGIN {}", env!("CARGO_MANIFEST_DIR"));
    }

    #[test]
    fn a_frame_is_a_little_endian_length_and_utf8_json() {
        let body = r#"{"kind":"public","request":{"text":"Ünïcödé ✓"}}"#;
        let mut written = Vec::new();
        write_frame(&mut written, body).expect("write");
        assert_eq!(
            &written[..4],
            &(body.len() as u32).to_le_bytes(),
            "four-byte unsigned little-endian length"
        );
        assert_eq!(&written[4..], body.as_bytes());
        let mut reader = Cursor::new(written);
        assert_eq!(read_frame(&mut reader), Ok(Some(body.to_string())));
        assert_eq!(read_frame(&mut reader), Ok(None), "a clean end of stream");
    }

    #[test]
    fn two_frames_in_one_stream_stay_separate() {
        let mut bytes = frame(br#"{"kind":"process","process":{"type":"cancel","callId":"a"}}"#);
        bytes.extend(frame(br#"{"kind":"trust"}"#));
        let mut reader = Cursor::new(bytes);
        assert_eq!(
            read_frame(&mut reader),
            Ok(Some(
                r#"{"kind":"process","process":{"type":"cancel","callId":"a"}}"#.to_string()
            ))
        );
        assert_eq!(
            read_frame(&mut reader),
            Ok(Some(r#"{"kind":"trust"}"#.to_string()))
        );
        assert_eq!(read_frame(&mut reader), Ok(None));
    }

    #[test]
    fn a_length_above_16_mib_is_rejected_before_allocation() {
        for length in [PIPE_FRAME_BYTES as u32 + 1, u32::MAX] {
            let mut reader = Counting {
                header: length.to_le_bytes(),
                taken: 0,
            };
            assert_eq!(
                read_frame(&mut reader),
                Err(FrameError::FrameLimit),
                "length {length}"
            );
            assert!(
                reader.taken <= 4 + 64,
                "the reader takes no body bytes: {} taken",
                reader.taken
            );
        }
    }

    #[test]
    fn a_length_of_exactly_16_mib_is_accepted() {
        let body = format!("\"{}\"", "a".repeat(PIPE_FRAME_BYTES - 2));
        let mut reader = Cursor::new(frame(body.as_bytes()));
        assert_eq!(
            read_frame(&mut reader).expect("read").map(|b| b.len()),
            Some(PIPE_FRAME_BYTES)
        );
        let mut written = Vec::new();
        write_frame(&mut written, &body).expect("write at the bound");
        let above = format!("\"{}\"", "a".repeat(PIPE_FRAME_BYTES - 1));
        assert_eq!(
            write_frame(&mut Vec::new(), &above),
            Err(FrameError::FrameLimit),
            "a body above 16 MiB is not written"
        );
    }

    #[test]
    fn a_public_request_above_2_mib_gives_frame_limit() {
        // Feature 005 contract Δ5: the same value as `src/contracts/limits.ts`.
        assert_eq!(PUBLIC_REQUEST_BYTES, 2_097_152);
        let at_bound = format!("{{\"pad\":\"{}\"}}", "a".repeat(PUBLIC_REQUEST_BYTES - 10));
        assert_eq!(at_bound.len(), PUBLIC_REQUEST_BYTES);
        let body = public_request_body(&at_bound).expect("an envelope of exactly 2 MiB");
        assert_eq!(
            body,
            format!("{{\"kind\":\"public\",\"request\":{at_bound}}}")
        );
        assert_eq!(body.len(), PUBLIC_FRAME_BODY_BYTES);
        let above = format!("{{\"pad\":\"{}\"}}", "a".repeat(PUBLIC_REQUEST_BYTES - 9));
        assert_eq!(public_request_body(&above), Err(FrameError::FrameLimit));
    }

    #[test]
    fn invalid_utf8_is_rejected() {
        for body in [
            &b"{\"a\":\"\xff\"}"[..],
            &b"{\"a\":\"\xc3\"}"[..],
            &b"{\"a\":\"\xed\xa0\x80\"}"[..],
        ] {
            let mut reader = Cursor::new(frame(body));
            assert_eq!(
                read_frame(&mut reader),
                Err(FrameError::InvalidUtf8),
                "{body:?}"
            );
        }
    }

    #[test]
    fn a_truncated_frame_at_the_end_of_the_stream_is_an_error() {
        let whole = frame(br#"{"kind":"public"}"#);
        for cut in [1, 2, 3, 4, 5, whole.len() - 1] {
            let mut reader = Cursor::new(whole[..cut].to_vec());
            assert_eq!(
                read_frame(&mut reader),
                Err(FrameError::Truncated),
                "cut after {cut} bytes"
            );
        }
    }
}
