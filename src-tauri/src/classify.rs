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
