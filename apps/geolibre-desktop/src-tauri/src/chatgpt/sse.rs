use super::{failure, Result, Value};

#[derive(Default)]
pub struct Parser {
    pending: Vec<u8>,
}
impl Parser {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>> {
        self.pending.extend_from_slice(bytes);
        if self.pending.len() > 8 * 1024 * 1024 {
            return Err(failure("stream", "ChatGPT stream event was too large."));
        }
        let mut output = Vec::new();
        loop {
            let delimiter = self
                .pending
                .windows(2)
                .position(|w| w == b"\n\n")
                .map(|p| (p, 2));
            let crlf = self
                .pending
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .map(|p| (p, 4));
            let next = match (delimiter, crlf) {
                (Some(a), Some(b)) => Some(if a.0 < b.0 { a } else { b }),
                (a, b) => a.or(b),
            };
            let Some((end, len)) = next else {
                break;
            };
            let frame: Vec<_> = self.pending.drain(..end + len).collect();
            let text = std::str::from_utf8(&frame)
                .map_err(|_| failure("stream", "Invalid ChatGPT stream encoding."))?;
            let data = text
                .lines()
                .filter_map(|line| {
                    line.strip_prefix("data:")
                        .map(|s| s.strip_prefix(' ').unwrap_or(s))
                })
                .collect::<Vec<_>>()
                .join("\n");
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            output.push(
                serde_json::from_str(&data)
                    .map_err(|_| failure("stream", "Invalid ChatGPT stream event."))?,
            );
        }
        Ok(output)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fragmented_utf8_and_crlf() {
        let bytes = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"🌍\"}\r\n\r\ndata: {\"type\":\"response.completed\"}\n\n".as_bytes();
        for split in 0..bytes.len() {
            let mut parser = Parser::default();
            let mut out = parser.push(&bytes[..split]).unwrap();
            out.extend(parser.push(&bytes[split..]).unwrap());
            assert_eq!(out.len(), 2);
            assert_eq!(out[0]["delta"], "🌍");
        }
    }
}
