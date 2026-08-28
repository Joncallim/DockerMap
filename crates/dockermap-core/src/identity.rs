//! Stable, collision-resistant topology identifiers.

use sha2::{Digest, Sha256};

/// Build a stable topology-ID component from the complete raw identity.
///
/// The readable slug deliberately preserves case and the common `-`, `_`, and
/// `.` punctuation; all other scalars may collapse for readability, but the
/// full SHA-256 suffix is calculated from the untouched UTF-8 bytes. Therefore
/// distinct paths, package names, controls, and punctuation variants cannot
/// merge merely because their display slugs look alike.
pub fn collision_resistant_id_component(value: &str) -> String {
    let mut slug = String::new();
    let mut emitted_separator = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
            slug.push(character);
            emitted_separator = false;
        } else if !emitted_separator {
            slug.push('-');
            emitted_separator = true;
        }
    }
    let slug = slug.trim_matches('-');
    let readable: String = if slug.is_empty() {
        "identity".into()
    } else {
        slug.chars().take(48).collect()
    };
    let digest = Sha256::digest(value.as_bytes());
    let suffix = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{readable}--{suffix}")
}
