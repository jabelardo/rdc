//! Interpreting git's transfer progress.
//!
//! Ported from `desktop-plus/app/src/lib/progress/git.ts`, plus the step tables in
//! `progress/{push,fetch,pull}.ts`.
//!
//! # What git emits
//!
//! git writes progress to stderr as carriage-return-delimited lines in a documented shape (see
//! git's `progress.c`):
//!
//! ```text
//! remote: Counting objects: 123
//! remote: Counting objects: 167587, done.
//! Receiving objects:  99% (166741/167587), 272.10 MiB | 2.39 MiB/s
//! Checking out files:  100% (728/728), done
//! ```
//!
//! Everything before the **last** `": "` is the *title*; what follows is the value, optionally with a
//! total, a percentage, throughput, and a `done.` marker.
//!
//! # Turning steps into one number
//!
//! An operation is several titled steps, each reported 0–100%. A [`GitProgressParser`] is given those
//! steps with relative weights and produces a single fraction. Two behaviours are load-bearing and
//! easy to lose:
//!
//! - **Steps may be skipped.** A push against a server with nothing to compress never reports
//!   `Compressing objects`. So when a step is recognised, every *earlier* step counts as complete.
//! - **Progress must not go backwards.** A line that isn't recognised reports the last percentage
//!   rather than zero, which is why the parser is stateful and single-use per operation.

use std::sync::OnceLock;

use regex::Regex;

/// One titled step of an operation, and its weight relative to the others.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProgressStep {
    /// The title exactly as git writes it, e.g. `remote: Compressing objects`.
    pub title: &'static str,
    /// Any number; weights are normalised against their sum.
    pub weight: f64,
}

/// A parsed git progress line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitProgressInfo {
    /// Everything before the last `": "`.
    pub title: String,
    /// Units processed.
    pub value: u64,
    /// Total units, when git reported one.
    pub total: Option<u64>,
    /// git's own rounded percentage, 0–100. Distinct from [`GitProgress::percent`], which is a
    /// high-precision fraction scaled across all steps.
    pub percent: Option<u32>,
    /// Whether the line ended with `done.`.
    pub done: bool,
    /// The line as it arrived.
    pub text: String,
}

/// What a line of git's stderr meant.
#[derive(Debug, Clone, PartialEq)]
pub enum GitProgress {
    /// A recognised step's progress.
    Progress {
        /// Overall completion as a fraction, scaled across the parser's steps.
        percent: f64,
        details: GitProgressInfo,
    },
    /// Anything else — a message, or a step this parser doesn't track.
    Context {
        /// The last overall percentage, so progress doesn't jump backwards.
        percent: f64,
        text: String,
    },
}

impl GitProgress {
    /// The overall fraction, whichever variant this is.
    pub fn percent(&self) -> f64 {
        match self {
            Self::Progress { percent, .. } | Self::Context { percent, .. } => *percent,
        }
    }

    /// The text best describing this event.
    ///
    /// The original chose `details.text` for progress and `text` for context at every call site.
    pub fn description(&self) -> &str {
        match self {
            Self::Progress { details, .. } => &details.text,
            Self::Context { text, .. } => text,
        }
    }
}

/// Turns git's per-step progress into one overall fraction.
///
/// Single-use: it carries the state that keeps progress monotonic, so one parser serves one
/// invocation of git.
#[derive(Debug, Clone)]
pub struct GitProgressParser {
    /// Steps with weights normalised to sum to 1.
    steps: Vec<ProgressStep>,
    /// The furthest step seen, so a step recognised out of order doesn't rewind.
    step_index: usize,
    last_percent: f64,
}

impl GitProgressParser {
    /// Builds a parser for `steps`, in the order git reports them.
    ///
    /// Weights are normalised, so they can be given as fractions or as arbitrary relative numbers.
    /// Panics on an empty list, as the original threw: a parser with no steps could only ever report
    /// zero, which would be a silent bug rather than a visible one.
    pub fn new(steps: &[ProgressStep]) -> Self {
        assert!(
            !steps.is_empty(),
            "a progress parser must have at least one step"
        );

        let total: f64 = steps.iter().map(|step| step.weight).sum();
        assert!(total > 0.0, "step weights must sum to more than zero");

        Self {
            steps: steps
                .iter()
                .map(|step| ProgressStep {
                    title: step.title,
                    weight: step.weight / total,
                })
                .collect(),
            step_index: 0,
            last_percent: 0.0,
        }
    }

    /// The steps of a `git push`.
    ///
    /// The original's comment is worth keeping: "highly approximate (some would say outright
    /// inaccurate)". Note `Compressing objects` here has no `remote: ` prefix while
    /// `remote: Resolving deltas` does — that asymmetry is git's, and copying it exactly is why these
    /// tables are transcribed rather than tidied.
    pub fn push() -> Self {
        Self::new(&[
            ProgressStep {
                title: "Compressing objects",
                weight: 0.2,
            },
            ProgressStep {
                title: "Writing objects",
                weight: 0.7,
            },
            ProgressStep {
                title: "remote: Resolving deltas",
                weight: 0.1,
            },
        ])
    }

    /// The steps of a `git fetch`.
    pub fn fetch() -> Self {
        Self::new(&[
            ProgressStep {
                title: "remote: Compressing objects",
                weight: 0.1,
            },
            ProgressStep {
                title: "Receiving objects",
                weight: 0.7,
            },
            ProgressStep {
                title: "Resolving deltas",
                weight: 0.2,
            },
        ])
    }

    /// The steps of a `git pull`.
    ///
    /// A fetch plus a possible checkout at the end, which the original assumed is quick.
    pub fn pull() -> Self {
        Self::new(&[
            ProgressStep {
                title: "remote: Compressing objects",
                weight: 0.1,
            },
            ProgressStep {
                title: "Receiving objects",
                weight: 0.7,
            },
            ProgressStep {
                title: "Resolving deltas",
                weight: 0.15,
            },
            ProgressStep {
                title: "Checking out files",
                weight: 0.15,
            },
        ])
    }

    /// The steps of a `git clone`.
    ///
    /// A fetch plus a checkout of everything, so the checkout is weighted more heavily than in a pull.
    pub fn clone() -> Self {
        Self::new(&[
            ProgressStep {
                title: "remote: Compressing objects",
                weight: 0.1,
            },
            ProgressStep {
                title: "Receiving objects",
                weight: 0.6,
            },
            ProgressStep {
                title: "Resolving deltas",
                weight: 0.1,
            },
            ProgressStep {
                title: "Checking out files",
                weight: 0.2,
            },
        ])
    }

    /// Interprets one line of git's stderr.
    ///
    /// A line whose title isn't one of this parser's steps — or which isn't progress at all — comes
    /// back as [`GitProgress::Context`] carrying the last percentage.
    pub fn parse(&mut self, line: &str) -> GitProgress {
        // git colours and repositions its progress output; the result is shown to the user as plain
        // text, so control sequences are stripped first.
        let text = strip_control_sequences(line);

        let Some(progress) = parse_progress_line(&text) else {
            return GitProgress::Context {
                percent: self.last_percent,
                text,
            };
        };

        let mut percent = 0.0;

        for (index, step) in self.steps.iter().enumerate() {
            if index >= self.step_index && progress.title == step.title {
                if let Some(total) = progress.total.filter(|total| *total > 0) {
                    percent += step.weight * (progress.value as f64 / total as f64);
                }

                self.step_index = index;
                self.last_percent = percent;

                return GitProgress::Progress {
                    percent,
                    details: progress,
                };
            }

            // Not this step, so assume it finished — a step git never reported is complete for our
            // purposes.
            percent += step.weight;
        }

        // A well-formed progress line for a step we don't track.
        GitProgress::Context {
            percent: self.last_percent,
            text,
        }
    }
}

/// Removes ANSI escape sequences.
///
/// Stands in for Node's `stripVTControlCharacters`. Only CSI sequences (`ESC [ … final`) and a bare
/// `ESC` are handled, which is what git emits for colour and cursor movement.
fn strip_control_sequences(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut characters = text.chars().peekable();

    while let Some(character) = characters.next() {
        if character != '\u{1b}' {
            output.push(character);
            continue;
        }

        // `ESC [` begins a control sequence that runs to its first byte in `@`..=`~`.
        if characters.peek() == Some(&'[') {
            characters.next();
            for inner in characters.by_ref() {
                if ('\u{40}'..='\u{7e}').contains(&inner) {
                    break;
                }
            }
        }
    }

    output
}

/// Parses a single progress line, or `None` if it isn't one.
///
/// Ported from `parse` in `progress/git.ts`.
pub fn parse_progress_line(line: &str) -> Option<GitProgressInfo> {
    // The *last* `": "` separates title from progress, because a title may itself contain one —
    // `remote: Compressing objects` does.
    let title_length = line.rfind(": ")?;

    // A line starting with `": "` has no title.
    if title_length == 0 {
        return None;
    }

    let title = &line[..title_length];
    let progress_text = line[title_length + 2..].trim();

    if progress_text.is_empty() {
        return None;
    }

    // git separates the value from throughput and the done marker with `, `.
    let parts: Vec<&str> = progress_text.split(", ").collect();
    let first = parts.first()?;

    let (value, total, percent) = if value_only_pattern().is_match(first) {
        // `remote: Counting objects: 123` — a count with no known total.
        (first.parse::<u64>().ok()?, None, None)
    } else {
        let captures = percent_pattern().captures(first)?;
        let percent: u32 = captures.get(1)?.as_str().parse().ok()?;
        let value: u64 = captures.get(2)?.as_str().parse().ok()?;
        let total: u64 = captures.get(3)?.as_str().parse().ok()?;
        (value, Some(total), Some(percent))
    };

    // Throughput isn't parsed; only the done marker is looked for among the remaining parts.
    let done = parts.iter().skip(1).any(|part| *part == "done.");

    Some(GitProgressInfo {
        title: title.to_owned(),
        value,
        total,
        percent,
        done,
        text: line.to_owned(),
    })
}

fn percent_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^(\d{1,3})% \((\d+)/(\d+)\)$").expect("pattern is valid"))
}

fn value_only_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^\d+$").expect("pattern is valid"))
}

/// Splits git's stderr into progress lines across arbitrary chunk boundaries.
///
/// git delimits progress with `\r` so each update overwrites the last on a terminal, and finishes a
/// step with `\n`. Chunks arrive at whatever size the pipe delivers, so a line can be split anywhere —
/// the same problem `checkout` and `rebase` solve locally, generalised here.
#[derive(Debug, Default)]
pub struct ProgressLineSplitter {
    buffer: String,
}

impl ProgressLineSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds a chunk, returning whatever complete lines it completed.
    ///
    /// Decoded lossily: git's progress is text, and a chunk boundary can fall mid-character, which
    /// must not abort the operation.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.push_str(&String::from_utf8_lossy(chunk));

        let mut lines = Vec::new();
        while let Some(position) = self.buffer.find(['\r', '\n']) {
            let line: String = self.buffer.drain(..position).collect();
            // Drop the delimiter itself.
            self.buffer.drain(..1);

            if !line.is_empty() {
                lines.push(line);
            }
        }

        lines
    }

    /// Whatever is left when git exits, which may be a final line with no delimiter.
    pub fn flush(&mut self) -> Option<String> {
        let remaining = std::mem::take(&mut self.buffer);
        (!remaining.is_empty()).then_some(remaining)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(line: &str) -> GitProgressInfo {
        parse_progress_line(line).unwrap_or_else(|| panic!("{line:?} should parse"))
    }

    // --- line parsing ---

    #[test]
    fn parses_a_count_with_no_total() {
        let parsed = info("remote: Counting objects: 123");
        assert_eq!(parsed.title, "remote: Counting objects");
        assert_eq!(parsed.value, 123);
        assert_eq!(parsed.total, None);
        assert_eq!(parsed.percent, None);
        assert!(!parsed.done);
    }

    #[test]
    fn parses_a_count_marked_done() {
        let parsed = info("remote: Counting objects: 167587, done.");
        assert_eq!(parsed.value, 167_587);
        assert!(parsed.done);
    }

    #[test]
    fn parses_a_percentage_with_throughput() {
        let parsed = info("Receiving objects:  99% (166741/167587), 272.10 MiB | 2.39 MiB/s");
        assert_eq!(parsed.title, "Receiving objects");
        assert_eq!(parsed.percent, Some(99));
        assert_eq!(parsed.value, 166_741);
        assert_eq!(parsed.total, Some(167_587));
        assert!(!parsed.done, "throughput is not a done marker");
    }

    #[test]
    fn parses_a_completed_percentage() {
        let parsed = info("Checking out files:  100% (728/728), done.");
        assert_eq!(parsed.value, 728);
        assert_eq!(parsed.total, Some(728));
        assert!(parsed.done);
    }

    #[test]
    fn splits_the_title_on_the_last_separator() {
        // `remote: Compressing objects` contains a `": "` of its own, so splitting on the first would
        // make the title just "remote".
        let parsed = info("remote: Compressing objects:  14% (159/1133)");
        assert_eq!(parsed.title, "remote: Compressing objects");
        assert_eq!(parsed.value, 159);
    }

    #[test]
    fn keeps_the_original_text() {
        let line = "Receiving objects:  50% (1/2)";
        assert_eq!(info(line).text, line);
    }

    #[test]
    fn rejects_lines_that_are_not_progress() {
        for line in [
            "",
            "Everything up-to-date",
            ": no title",
            "Receiving objects: ",
            "Receiving objects: not a number",
            "Receiving objects:  50% (1/2/3)",
        ] {
            assert_eq!(parse_progress_line(line), None, "{line:?} should not parse");
        }
    }

    #[test]
    fn rejects_a_percentage_over_three_digits() {
        // The original's `\d{1,3}`; a four-digit percentage is not something git emits.
        assert_eq!(parse_progress_line("Receiving objects: 1000% (1/2)"), None);
    }

    // --- control sequences ---

    #[test]
    fn strips_ansi_colour_codes() {
        assert_eq!(
            strip_control_sequences("\u{1b}[32mReceiving objects:  50% (1/2)\u{1b}[0m"),
            "Receiving objects:  50% (1/2)"
        );
    }

    #[test]
    fn leaves_plain_text_alone() {
        assert_eq!(
            strip_control_sequences("Receiving objects:  50% (1/2)"),
            "Receiving objects:  50% (1/2)"
        );
    }

    #[test]
    fn parses_a_progress_line_that_arrived_coloured() {
        let mut parser = GitProgressParser::fetch();
        let progress = parser.parse("\u{1b}[KReceiving objects:  50% (1/2)");

        match progress {
            GitProgress::Progress { details, .. } => {
                assert_eq!(details.title, "Receiving objects");
            }
            other => panic!("expected progress, got {other:?}"),
        }
    }

    // --- step weighting ---

    #[test]
    fn scales_a_step_by_its_weight() {
        let mut parser = GitProgressParser::fetch();
        // `remote: Compressing objects` carries weight 0.1, so half of it is 0.05.
        let progress = parser.parse("remote: Compressing objects:  50% (1/2)");
        assert!((progress.percent() - 0.05).abs() < 1e-9, "got {progress:?}");
    }

    #[test]
    fn counts_earlier_steps_as_complete_when_a_later_one_appears() {
        // The behaviour that matters: a fetch with nothing to compress never reports the first step,
        // and progress must not start from zero when the second arrives.
        let mut parser = GitProgressParser::fetch();
        let progress = parser.parse("Receiving objects:  50% (1/2)");

        // 0.1 for the skipped compression step, plus half of Receiving's 0.7.
        assert!(
            (progress.percent() - 0.45).abs() < 1e-9,
            "got {}",
            progress.percent()
        );
    }

    #[test]
    fn reaches_one_at_the_end_of_the_last_step() {
        let mut parser = GitProgressParser::fetch();
        let progress = parser.parse("Resolving deltas:  100% (10/10), done.");
        assert!((progress.percent() - 1.0).abs() < 1e-9, "got {progress:?}");
    }

    #[test]
    fn does_not_rewind_when_an_earlier_step_reappears() {
        // git can interleave steps; once we've moved on, an older title must not drag progress back.
        let mut parser = GitProgressParser::fetch();
        let advanced = parser.parse("Receiving objects:  50% (1/2)").percent();
        let after = parser
            .parse("remote: Compressing objects:  10% (1/10)")
            .percent();

        assert!(
            after >= advanced,
            "progress went backwards: {advanced} then {after}"
        );
    }

    #[test]
    fn an_unrecognized_line_reports_the_last_percentage() {
        let mut parser = GitProgressParser::fetch();
        let advanced = parser.parse("Receiving objects:  50% (1/2)").percent();

        match parser.parse("remote: Enumerating objects: 5, done.") {
            GitProgress::Context { percent, text } => {
                assert!((percent - advanced).abs() < 1e-9);
                assert_eq!(text, "remote: Enumerating objects: 5, done.");
            }
            other => panic!("expected context, got {other:?}"),
        }
    }

    #[test]
    fn a_message_before_any_progress_reports_zero() {
        let mut parser = GitProgressParser::push();
        assert_eq!(parser.parse("Everything up-to-date").percent(), 0.0);
    }

    #[test]
    fn a_step_with_a_zero_total_contributes_nothing_rather_than_dividing_by_zero() {
        let mut parser = GitProgressParser::fetch();
        let progress = parser.parse("remote: Compressing objects:  0% (0/0)");
        assert_eq!(progress.percent(), 0.0);
    }

    #[test]
    fn normalises_weights_that_do_not_sum_to_one() {
        let mut parser = GitProgressParser::new(&[
            ProgressStep {
                title: "First",
                weight: 1.0,
            },
            ProgressStep {
                title: "Second",
                weight: 3.0,
            },
        ]);

        // First is a quarter of the total weight, so completing it gives 0.25.
        let progress = parser.parse("First:  100% (2/2)");
        assert!((progress.percent() - 0.25).abs() < 1e-9, "got {progress:?}");
    }

    #[test]
    #[should_panic(expected = "at least one step")]
    fn refuses_to_build_a_parser_with_no_steps() {
        // Such a parser could only ever report zero, which would be a silent bug.
        let _ = GitProgressParser::new(&[]);
    }

    #[test]
    fn the_push_steps_keep_gits_asymmetric_titles() {
        // `Compressing objects` has no `remote: ` prefix in a push while `remote: Resolving deltas`
        // does. That looks like a typo and isn't — it's what git emits.
        let mut parser = GitProgressParser::push();
        assert!(matches!(
            parser.parse("Compressing objects:  50% (1/2)"),
            GitProgress::Progress { .. }
        ));

        let mut parser = GitProgressParser::push();
        assert!(matches!(
            parser.parse("remote: Compressing objects:  50% (1/2)"),
            GitProgress::Context { .. }
        ));
    }

    #[test]
    fn clone_weights_the_checkout_more_heavily_than_pull_does() {
        // A clone checks out every file; a pull usually touches a few.
        let mut clone = GitProgressParser::clone();
        let clone_checkout = clone.parse("Checking out files:  100% (2/2)").percent();

        let mut pull = GitProgressParser::pull();
        let pull_before = pull.parse("Resolving deltas:  100% (2/2)").percent();
        let pull_checkout = pull.parse("Checking out files:  100% (2/2)").percent();

        assert!((clone_checkout - 1.0).abs() < 1e-9);
        assert!((pull_checkout - 1.0).abs() < 1e-9);
        assert!(
            pull_before > 0.8,
            "a pull is nearly done before checking out, got {pull_before}"
        );
    }

    #[test]
    fn pull_tracks_a_checkout_step_that_fetch_does_not() {
        let mut pull = GitProgressParser::pull();
        assert!(matches!(
            pull.parse("Checking out files:  50% (1/2)"),
            GitProgress::Progress { .. }
        ));

        let mut fetch = GitProgressParser::fetch();
        assert!(matches!(
            fetch.parse("Checking out files:  50% (1/2)"),
            GitProgress::Context { .. }
        ));
    }

    #[test]
    fn describes_progress_with_the_line_and_context_with_the_message() {
        let mut parser = GitProgressParser::fetch();

        let progress = parser.parse("Receiving objects:  50% (1/2)");
        assert_eq!(progress.description(), "Receiving objects:  50% (1/2)");

        let context = parser.parse("Everything up-to-date");
        assert_eq!(context.description(), "Everything up-to-date");
    }

    // --- chunk splitting ---

    #[test]
    fn splits_progress_across_arbitrary_chunk_boundaries() {
        let mut splitter = ProgressLineSplitter::new();

        assert!(splitter.push(b"Receiving objects:  2").is_empty());
        assert_eq!(
            splitter.push(b"5% (1/4)\rReceiving objects:  100% (4/4), done.\n"),
            vec![
                "Receiving objects:  25% (1/4)".to_owned(),
                "Receiving objects:  100% (4/4), done.".to_owned(),
            ]
        );
    }

    #[test]
    fn treats_both_delimiters_as_line_ends() {
        let mut splitter = ProgressLineSplitter::new();
        assert_eq!(
            splitter.push(b"one\rtwo\nthree\r"),
            vec!["one".to_owned(), "two".to_owned(), "three".to_owned()]
        );
    }

    #[test]
    fn skips_empty_lines_from_consecutive_delimiters() {
        // git emits `\r\n` at the end of a step, which would otherwise produce a blank line.
        let mut splitter = ProgressLineSplitter::new();
        assert_eq!(
            splitter.push(b"one\r\ntwo\r\n"),
            vec!["one".to_owned(), "two".to_owned()]
        );
    }

    #[test]
    fn flushes_a_final_line_with_no_delimiter() {
        let mut splitter = ProgressLineSplitter::new();
        assert!(splitter.push(b"trailing").is_empty());
        assert_eq!(splitter.flush().as_deref(), Some("trailing"));
        assert_eq!(splitter.flush(), None, "flushing twice yields nothing");
    }

    #[test]
    fn survives_a_chunk_boundary_inside_a_character() {
        // A multi-byte character split across chunks must not abort the operation.
        let mut splitter = ProgressLineSplitter::new();
        let text = "Receiving 語\n".as_bytes();
        let (first, second) = text.split_at(11);

        let mut lines = splitter.push(first);
        lines.extend(splitter.push(second));

        assert_eq!(lines.len(), 1, "got {lines:?}");
    }
}
