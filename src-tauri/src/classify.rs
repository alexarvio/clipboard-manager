use once_cell::sync::Lazy;
use regex::Regex;

static EMAIL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$").unwrap());

static BANK_KEYWORDS_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(account\s*(no\.?|number|#)?|routing\s*(no\.?|number|#)?|iban|swift|sort\s*code)\b")
        .unwrap()
});

static PHONE_FORMATTED_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\+?[0-9][0-9()\-.\s]{5,17}[0-9]$").unwrap());

static DIGIT_RUN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[0-9][0-9\s-]{6,18}[0-9]$").unwrap());

static ADDRESS_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b\d{1,6}\s+[A-Za-z0-9.'\s]{2,40}\b(st|street|ave|avenue|blvd|boulevard|rd|road|ln|lane|dr|drive|way|ct|court|pl|place|pkwy|parkway|hwy|highway)\b",
    )
    .unwrap()
});

static IPV4_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$").unwrap()
});

static IPV6_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[0-9a-fA-F:]{2,39}$").unwrap());

static FILE_PATH_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^(?:[A-Za-z]:\\[^\s]*|/[^\s]+(?:/[^\s]+)+|~/[^\s]+)$").unwrap());

static PRICE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[$€£¥]\s?\d[\d,]*(\.\d{1,2})?|\b\d+(\.\d{1,2})?\s?(usd|eur|gbp)\b").unwrap());

static CODE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?m)(=>|;\s*$|\{\s*$|^\s*\}|\bfunction\b|\bconst\b|\blet\b|\bimport\b|\bdef\s+\w+\(|\bclass\s+\w+|^\s*#include|</?[a-zA-Z][^>]*>)",
    )
    .unwrap()
});

static DATE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)^\d{4}-\d{2}-\d{2}$|^\d{1,2}/\d{1,2}/\d{2,4}$|^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?(,?\s+\d{4})?$|^\d{1,2}:\d{2}(:\d{2})?\s?(am|pm)?$",
    )
    .unwrap()
});

// --- Secret / API key detection -----------------------------------------
//
// Used to flag entries for the blur-until-revealed treatment in history
// (see db.rs's `is_secret` column) and, more importantly, to keep flagged
// content out of every path that leaves the device (AI transform's "send
// selected item" affordance, the AI filter's item list, and the semantic
// search embedding pipeline -- see clipboard_listener.rs and main.rs).
// Known-prefix formats first (cheap, precise, near-zero false-positive
// rate), then a generic high-entropy fallback for anything that looks like
// a random token but doesn't match a known vendor's format.
static KNOWN_SECRET_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?x)
        sk-ant-[A-Za-z0-9_-]{20,}          # Anthropic
        | sk-[A-Za-z0-9]{20,}              # OpenAI
        | (sk|pk|rk)_(test|live)_[A-Za-z0-9]{10,}  # Stripe
        | gh[pousr]_[A-Za-z0-9]{30,}       # GitHub tokens
        | AKIA[0-9A-Z]{16}                 # AWS access key id
        | xox[baprs]-[A-Za-z0-9-]{10,}     # Slack tokens
        | AIza[0-9A-Za-z_-]{35}            # Google API key
        | pa-[A-Za-z0-9_-]{20,}            # Voyage AI
        | eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+  # JWT
        | -----BEGIN\s(RSA\s|EC\s|OPENSSH\s)?PRIVATE\sKEY-----  # PEM private key
        ",
    )
    .unwrap()
});

/// Shannon entropy in bits/char -- used only as the generic fallback below,
/// to catch unlabeled random-looking tokens that don't match any known
/// vendor prefix. Ordinary words and sentences score low (a handful of
/// distinct, unevenly-used characters); random tokens score high (many
/// distinct characters, close to uniformly used).
fn shannon_entropy(s: &str) -> f64 {
    let len = s.chars().count() as f64;
    if len == 0.0 {
        return 0.0;
    }
    let mut counts = std::collections::HashMap::new();
    for c in s.chars() {
        *counts.entry(c).or_insert(0u32) += 1;
    }
    counts
        .values()
        .map(|&n| {
            let p = n as f64 / len;
            -p * p.log2()
        })
        .sum()
}

/// Best-effort secret/API-key detection. Deliberately conservative on the
/// generic fallback (single whitespace-free token, length-gated, entropy-
/// gated, and mixed letters+digits required) -- it will still misfire
/// occasionally on things like long commit hashes or license keys, same
/// caveat classify() above already carries for its own patterns. Known
/// vendor prefixes are checked first and are effectively exact.
pub fn looks_like_secret(content: &str) -> bool {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return false;
    }
    if KNOWN_SECRET_RE.is_match(trimmed) {
        return true;
    }
    // Anything that already has a benign identity of its own is not a
    // secret, and must be excluded BEFORE the entropy fallback below --
    // otherwise that fallback swallows them, because "one token, 24+ chars,
    // letters and digits, high entropy" is also a plain description of a
    // URL, a file path, an email address or an IP. A link like
    // https://github.com/alexarvio/clipboard-manager/releases/tag/app-v0.2.1
    // scores well over the entropy threshold and was being blurred as an API
    // key (2026-08-31). Known vendor prefixes are still checked above this,
    // so a real key sitting in a URL's query string is caught regardless.
    match classify(trimmed) {
        "link" | "email" | "file_path" | "ip_address" => return false,
        _ => {}
    }
    // Belt and braces for URL shapes classify() doesn't label "link"
    // (scheme-relative, or a bare host with a path).
    if trimmed.contains("://") {
        return false;
    }

    // Generic fallback: a single token (no whitespace), long enough to be a
    // real secret rather than a word, with both letters and digits, and
    // entropy high enough that it doesn't read as a normal identifier/word.
    if trimmed.split_whitespace().count() != 1 {
        return false;
    }
    let token = trimmed;
    let len = token.chars().count();
    if !(24..=512).contains(&len) {
        return false;
    }
    let has_letter = token.chars().any(|c| c.is_ascii_alphabetic());
    let has_digit = token.chars().any(|c| c.is_ascii_digit());
    if !has_letter || !has_digit {
        return false;
    }
    shannon_entropy(token) >= 3.5
}

/// Best-effort classification of a clipboard entry into a coarse category,
/// used to power the Pro-only history filter. This is pattern matching, not
/// validation -- it will misclassify edge cases (e.g. a 10-digit number that
/// isn't a phone number), and "bank account" detection in particular is just
/// "looks like account/routing-number-shaped digits, or mentions those
/// words" -- there's no way to actually verify it's a real account number.
pub fn classify(content: &str) -> &'static str {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return "text";
    }
    let lower = trimmed.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("www.") {
        return "link";
    }
    if EMAIL_RE.is_match(trimmed) {
        return "email";
    }
    if IPV4_RE.is_match(trimmed)
        || (trimmed.matches(':').count() >= 2 && IPV6_RE.is_match(trimmed))
    {
        return "ip_address";
    }
    if FILE_PATH_RE.is_match(trimmed) {
        return "file_path";
    }
    if BANK_KEYWORDS_RE.is_match(trimmed) {
        return "bank_account";
    }
    let digit_count = trimmed.chars().filter(|c| c.is_ascii_digit()).count();
    let has_phone_punct = trimmed.starts_with('+')
        || trimmed.contains('(')
        || trimmed.contains(')')
        || trimmed.contains('-');
    if PHONE_FORMATTED_RE.is_match(trimmed) && has_phone_punct && (7..=15).contains(&digit_count) {
        return "phone";
    }
    if DIGIT_RUN_RE.is_match(trimmed) && (8..=17).contains(&digit_count) {
        return "bank_account";
    }
    if ADDRESS_RE.is_match(trimmed) {
        return "address";
    }
    if DATE_RE.is_match(trimmed) {
        return "date_time";
    }
    if PRICE_RE.is_match(trimmed) {
        return "price";
    }
    if CODE_RE.is_match(trimmed) {
        return "code";
    }
    "text"
}
