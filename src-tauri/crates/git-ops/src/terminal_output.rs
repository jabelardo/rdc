//! Rolling buffer of git terminal output (combined stdout + stderr).
//!
//! Ported from `desktop-plus/app/src/lib/git/push-terminal-chunk.ts`. The buffer exists so a
//! failing git command can be reported with "terminal-like" context, capped so that a chatty
//! command can't grow it without bound.
//!
//! # Deviation from the TypeScript original (deliberate, and partly forced)
//!
//! The original caps on **JavaScript string length**, i.e. UTF-16 code units — its tests assert
//! that `'日本語ab'` has length 5 and that `'👋'` "counts as 2". This port caps on **UTF-8
//! bytes** instead, for two reasons:
//!
//! 1. Exact parity is *unrepresentable* in Rust. Trimming by UTF-16 index can cut a surrogate
//!    pair in half; JavaScript happily holds the resulting lone surrogate, but Rust's `String`
//!    is guaranteed valid UTF-8 and cannot. So byte-or-char semantics is not a free choice.
//! 2. The capacity is a memory bound, and bytes are the honest unit for that in Rust.
//!
//! Trimming rounds *up* to the next character boundary, so this version can never emit invalid
//! or mangled UTF-8 — an improvement over the original, which can leave a broken leading
//! character. The consequence is that it may retain slightly fewer bytes than `capacity`, never
//! more.

/// Appends a chunk of terminal output to `chunks`, trimming from the front so the total stays
/// within `capacity` bytes.
///
/// `chunks` is mutated in place. Oldest content is dropped first; when a chunk only partially
/// overflows, its leading bytes are trimmed at a character boundary.
pub fn push_terminal_chunk(chunks: &mut Vec<String>, capacity: usize, chunk: &str) {
    chunks.push(chunk.to_owned());
    let mut total: usize = chunks.iter().map(String::len).sum();

    while total > capacity {
        // `while total > capacity` guarantees a non-empty buffer here: an empty buffer has
        // total == 0, which cannot exceed `capacity`.
        let first_len = chunks[0].len();
        let overrun = total - capacity;

        if overrun >= first_len {
            chunks.remove(0);
            total -= first_len;
        } else {
            // Round the cut up to the next char boundary so we never split a UTF-8 sequence.
            let first = &chunks[0];
            let mut cut = overrun;
            while cut < first.len() && !first.is_char_boundary(cut) {
                cut += 1;
            }
            chunks[0] = first[cut..].to_owned();
            total -= cut;
        }
    }
}

/// Same as [`push_terminal_chunk`], for raw process output.
///
/// Invalid UTF-8 is replaced with U+FFFD, matching the original's `coerce-to-string.ts`, which
/// went through Node's `Buffer::toString('utf8')`.
pub fn push_terminal_bytes(chunks: &mut Vec<String>, capacity: usize, chunk: &[u8]) {
    push_terminal_chunk(chunks, capacity, &String::from_utf8_lossy(chunk));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn joined(chunks: &[String]) -> String {
        chunks.concat()
    }

    // --- basic functionality ---

    #[test]
    fn appends_a_chunk_to_an_empty_buffer() {
        let mut chunks = Vec::new();
        push_terminal_chunk(&mut chunks, 100, "hello");
        assert_eq!(chunks, ["hello"]);
    }

    #[test]
    fn appends_multiple_chunks() {
        let mut chunks = Vec::new();
        push_terminal_chunk(&mut chunks, 100, "hello");
        push_terminal_chunk(&mut chunks, 100, " world");
        assert_eq!(chunks, ["hello", " world"]);
    }

    #[test]
    fn appends_a_byte_chunk_by_converting_it_to_a_string() {
        let mut chunks = Vec::new();
        push_terminal_bytes(&mut chunks, 100, b"hello");
        assert_eq!(chunks, ["hello"]);
    }

    #[test]
    fn appends_an_empty_chunk() {
        let mut chunks = Vec::new();
        push_terminal_chunk(&mut chunks, 100, "");
        assert_eq!(chunks, [""]);
    }

    #[test]
    fn appends_an_empty_byte_chunk() {
        let mut chunks = Vec::new();
        push_terminal_bytes(&mut chunks, 100, b"");
        assert_eq!(chunks, [""]);
    }

    // --- capacity management ---

    #[test]
    fn does_not_trim_when_total_length_equals_capacity() {
        let mut chunks = Vec::new();
        push_terminal_chunk(&mut chunks, 10, "0123456789");
        assert_eq!(chunks, ["0123456789"]);
        assert_eq!(joined(&chunks).len(), 10);
    }

    #[test]
    fn does_not_trim_when_total_length_is_under_capacity() {
        let mut chunks = Vec::new();
        push_terminal_chunk(&mut chunks, 10, "12345");
        assert_eq!(chunks, ["12345"]);
    }

    #[test]
    fn removes_entire_first_chunk_when_overrun_exceeds_its_length() {
        let mut chunks = vec!["abc".to_owned(), "def".to_owned()];
        push_terminal_chunk(&mut chunks, 6, "ghij");
        // Total would be 10, capacity is 6, overrun is 4. "abc" (3) goes entirely, leaving an
        // overrun of 1, so "def" becomes "ef".
        assert_eq!(chunks, ["ef", "ghij"]);
        assert_eq!(joined(&chunks).len(), 6);
    }

    #[test]
    fn partially_trims_first_chunk_when_overrun_is_smaller_than_it() {
        let mut chunks = vec!["abcdef".to_owned()];
        push_terminal_chunk(&mut chunks, 8, "ghi");
        assert_eq!(chunks, ["bcdef", "ghi"]);
        assert_eq!(joined(&chunks).len(), 8);
    }

    #[test]
    fn removes_multiple_chunks_when_necessary() {
        let mut chunks = vec!["aa".to_owned(), "bb".to_owned(), "cc".to_owned()];
        push_terminal_chunk(&mut chunks, 4, "dddd");
        assert_eq!(chunks, ["dddd"]);
        assert_eq!(joined(&chunks).len(), 4);
    }

    #[test]
    fn handles_a_single_chunk_that_exceeds_capacity() {
        let mut chunks = Vec::new();
        push_terminal_chunk(&mut chunks, 5, "0123456789");
        assert_eq!(chunks, ["56789"]);
    }

    #[test]
    fn handles_capacity_of_zero() {
        let mut chunks = Vec::new();
        push_terminal_chunk(&mut chunks, 0, "hello");
        // Everything is trimmed, including the now-empty chunk.
        assert!(chunks.is_empty());
    }

    #[test]
    fn handles_capacity_of_one() {
        let mut chunks = Vec::new();
        push_terminal_chunk(&mut chunks, 1, "hello");
        assert_eq!(chunks, ["o"]);
    }

    // --- rolling buffer behaviour ---

    #[test]
    fn maintains_a_rolling_buffer_across_repeated_pushes() {
        let mut chunks = Vec::new();
        let capacity = 15;

        push_terminal_chunk(&mut chunks, capacity, "aaaaa");
        assert_eq!(joined(&chunks).len(), 5);
        push_terminal_chunk(&mut chunks, capacity, "bbbbb");
        assert_eq!(joined(&chunks).len(), 10);
        push_terminal_chunk(&mut chunks, capacity, "ccccc");
        assert_eq!(joined(&chunks).len(), 15);

        push_terminal_chunk(&mut chunks, capacity, "ddddd");
        assert_eq!(joined(&chunks), "bbbbbcccccddddd");
        push_terminal_chunk(&mut chunks, capacity, "eeeee");
        assert_eq!(joined(&chunks), "cccccdddddeeeee");
    }

    #[test]
    fn preserves_newest_content_when_trimming() {
        let mut chunks = Vec::new();
        push_terminal_chunk(&mut chunks, 10, "old_data_");
        push_terminal_chunk(&mut chunks, 10, "new_data");
        let result = joined(&chunks);
        assert!(result.ends_with("new_data"));
        assert_eq!(result.len(), 10);
    }

    // --- edge cases ---
    //
    // The three unicode cases below are where this port intentionally diverges from the
    // TypeScript original, which counts UTF-16 code units. See the module docs.

    #[test]
    fn caps_unicode_on_bytes_not_utf16_code_units() {
        let mut chunks = Vec::new();
        // The original asserts this is length 5 (UTF-16: 3 + 2) and so fits a capacity of 5
        // untrimmed. Here it is 11 bytes ("日本語" is 9, "ab" is 2), so it *is* trimmed: the
        // overrun of 6 lands exactly on the boundary before "語", keeping the newest 5 bytes.
        push_terminal_chunk(&mut chunks, 5, "日本語ab");
        let result = joined(&chunks);
        assert_eq!(result, "語ab");
        assert_eq!(result.len(), 5, "keeps as much recent output as fits");
    }

    #[test]
    fn retains_fewer_bytes_than_capacity_when_a_cut_lands_mid_character() {
        let mut chunks = Vec::new();
        // 9 bytes, capacity 4 => overrun 5, which is inside "本" (bytes 3..6). Rounding up to
        // byte 6 drops the whole character, so 3 bytes are kept rather than 4. Retaining less
        // than capacity is the deliberate trade for never emitting invalid UTF-8.
        push_terminal_chunk(&mut chunks, 4, "日本語");
        let result = joined(&chunks);
        assert_eq!(result, "語");
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn trims_unicode_at_character_boundaries() {
        let mut chunks = Vec::new();
        push_terminal_chunk(&mut chunks, 3, "日本語test");
        // Same observable result as the original here: 13 bytes, capacity 3, so the overrun of
        // 10 lands exactly on the boundary after "t".
        assert_eq!(chunks, ["est"]);
    }

    #[test]
    fn handles_emoji_without_splitting_surrogate_pairs() {
        let mut chunks = Vec::new();
        push_terminal_chunk(&mut chunks, 10, "👋hello");
        // The original asserts a length of 7 (👋 counting as 2 UTF-16 units). "👋" is 4 bytes
        // here, so 9 total — still under capacity, so nothing is trimmed either way.
        assert_eq!(joined(&chunks), "👋hello");
        assert_eq!(joined(&chunks).len(), 9);
    }

    #[test]
    fn never_produces_invalid_utf8_when_trimming_mid_character() {
        let mut chunks = Vec::new();
        // Capacity falls inside the 4-byte emoji; the whole char must go rather than be split.
        push_terminal_chunk(&mut chunks, 2, "👋ab");
        let result = joined(&chunks);
        assert_eq!(result, "ab");
        assert!(result.is_char_boundary(0));
    }

    #[test]
    fn handles_mixed_byte_and_string_inputs() {
        let mut chunks = Vec::new();
        push_terminal_chunk(&mut chunks, 30, "string_input");
        push_terminal_bytes(&mut chunks, 30, b"_buffer_input");
        assert_eq!(chunks, ["string_input", "_buffer_input"]);
    }

    #[test]
    fn handles_newlines_and_special_characters() {
        let mut chunks = Vec::new();
        push_terminal_chunk(&mut chunks, 20, "line1\nline2\r\n");
        assert_eq!(chunks, ["line1\nline2\r\n"]);
    }

    #[test]
    fn handles_ansi_escape_sequences() {
        let mut chunks = Vec::new();
        let ansi_colored = "\x1b[31mred\x1b[0m";
        push_terminal_chunk(&mut chunks, 50, ansi_colored);
        assert_eq!(chunks, [ansi_colored]);
    }

    // --- pre-existing buffer state ---

    #[test]
    fn works_with_a_pre_populated_buffer() {
        let mut chunks = vec!["existing".to_owned(), "content".to_owned()];
        push_terminal_chunk(&mut chunks, 20, "_new");
        assert_eq!(chunks, ["existing", "content", "_new"]);
    }

    #[test]
    fn trims_pre_existing_content_when_the_new_chunk_overflows() {
        let mut chunks = vec!["aaaa".to_owned(), "bbbb".to_owned()];
        push_terminal_chunk(&mut chunks, 10, "cccccc");
        assert_eq!(chunks, ["bbbb", "cccccc"]);
        assert_eq!(joined(&chunks).len(), 10);
    }

    // --- boundary conditions ---

    #[test]
    fn handles_the_exact_capacity_boundary() {
        let mut chunks = vec!["12345".to_owned()];
        push_terminal_chunk(&mut chunks, 10, "67890");
        assert_eq!(chunks, ["12345", "67890"]);
    }

    #[test]
    fn handles_one_byte_over_capacity() {
        let mut chunks = vec!["12345".to_owned()];
        push_terminal_chunk(&mut chunks, 10, "678901");
        assert_eq!(joined(&chunks), "2345678901");
    }

    #[test]
    fn handles_a_very_large_capacity_with_small_chunks() {
        let mut chunks = Vec::new();
        push_terminal_chunk(&mut chunks, 1_000_000, "small");
        assert_eq!(chunks, ["small"]);
    }

    #[test]
    fn handles_many_small_chunks() {
        let mut chunks = Vec::new();
        for _ in 0..10 {
            push_terminal_chunk(&mut chunks, 20, "xx");
        }
        assert_eq!(joined(&chunks).len(), 20);
    }

    #[test]
    fn handles_overrun_exactly_equal_to_the_first_chunk() {
        let mut chunks = vec!["abc".to_owned()];
        push_terminal_chunk(&mut chunks, 5, "defgh");
        assert_eq!(chunks, ["defgh"]);
    }

    // --- realistic terminal output ---

    #[test]
    fn simulates_git_push_output() {
        let mut chunks = Vec::new();
        for line in [
            "Enumerating objects: 5, done.\n",
            "Counting objects: 100% (5/5), done.\n",
            "Delta compression using up to 8 threads\n",
            "Compressing objects: 100% (3/3), done.\n",
            "Writing objects: 100% (3/3), 328 bytes | 328.00 KiB/s, done.\n",
        ] {
            push_terminal_chunk(&mut chunks, 1000, line);
        }
        let result = joined(&chunks);
        assert!(result.contains("Enumerating"));
        assert!(result.contains("Writing objects"));
    }

    #[test]
    fn simulates_progress_output_with_carriage_returns() {
        let mut chunks = Vec::new();
        for line in [
            "Progress: 25%\r",
            "Progress: 50%\r",
            "Progress: 75%\r",
            "Progress: 100%\n",
        ] {
            push_terminal_chunk(&mut chunks, 100, line);
        }
        assert!(joined(&chunks).contains("Progress: 100%"));
    }

    #[test]
    fn handles_large_output_needing_significant_trimming() {
        let mut chunks = Vec::new();
        for i in 0..50 {
            push_terminal_chunk(&mut chunks, 100, &format!("Line {i}: Some output data\n"));
        }
        let result = joined(&chunks);
        assert_eq!(result.len(), 100);
        assert!(!result.contains("Line 0:"), "only recent content is kept");
    }
}
