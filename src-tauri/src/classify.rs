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
    "text"
}
