use std::{env, fs, path::PathBuf};

fn strict_semver(value: &str) -> bool {
    let (without_build, build) = match value.split_once('+') {
        Some((without_build, build)) => (without_build, Some(build)),
        None => (value, None),
    };
    if build.is_some_and(|build| !valid_dot_identifiers(build, false)) {
        return false;
    }
    let (core, prerelease) = match without_build.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (without_build, None),
    };
    if core.split('.').count() != 3 || !core.split('.').all(valid_numeric_identifier) {
        return false;
    }
    prerelease.is_none_or(|prerelease| valid_dot_identifiers(prerelease, true))
}

fn valid_dot_identifiers(value: &str, reject_leading_zero_number: bool) -> bool {
    !value.is_empty()
        && value.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                && (!reject_leading_zero_number
                    || !part.bytes().all(|byte| byte.is_ascii_digit())
                    || valid_numeric_identifier(part))
        })
}

fn valid_numeric_identifier(part: &str) -> bool {
    !part.is_empty()
        && part.bytes().all(|byte| byte.is_ascii_digit())
        && (part == "0" || !part.starts_with('0'))
}

fn main() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"));
    let version_path = manifest_dir.join("../..").join("VERSION");
    println!("cargo:rerun-if-changed={}", version_path.display());
    println!("cargo:rerun-if-changed=build.rs");

    let root_version = fs::read_to_string(&version_path)
        .unwrap_or_else(|error| panic!("could not read {}: {error}", version_path.display()));
    let version = root_version
        .strip_suffix('\n')
        .filter(|version| !version.contains('\n'))
        .unwrap_or_else(|| {
            panic!(
                "{} must contain one SemVer value followed by a newline",
                version_path.display()
            )
        });
    assert!(
        strict_semver(version),
        "{} is not strict SemVer: {version:?}",
        version_path.display()
    );

    let cargo_version = env::var("CARGO_PKG_VERSION").expect("Cargo package version");
    assert_eq!(
        cargo_version, version,
        "dockermap-daemon Cargo package version must match root VERSION"
    );
}
