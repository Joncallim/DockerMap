pub(crate) mod cron;
pub(crate) mod listeners;
pub(crate) mod network_infrastructure;
pub(crate) mod npm;
pub(crate) mod overlay_network;
pub(crate) mod pm2;
pub(crate) mod processes;
pub(crate) mod systemd;
pub(crate) mod tmux;

/// Shared, bounded classification helpers for statically linked providers.
/// These are deliberately not exposed from the daemon entrypoint.
pub(crate) fn looks_like_ai_agent(value: &str) -> bool {
    [
        "openai",
        "anthropic",
        "langchain",
        "llamaindex",
        "autogen",
        "crewai",
        "agent",
        "@modelcontextprotocol/sdk",
    ]
    .into_iter()
    .any(|needle| value.contains(needle))
}

pub(crate) fn non_empty_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
mod shared_helper_tests {
    use super::{looks_like_ai_agent, non_empty_string};

    #[test]
    fn shared_provider_classification_and_optional_text_remain_bounded() {
        assert!(looks_like_ai_agent("langchain-worker"));
        assert!(!looks_like_ai_agent("ordinary-service"));
        assert_eq!(
            non_empty_string("  configured  ").as_deref(),
            Some("configured")
        );
        assert_eq!(non_empty_string("\t\n"), None);
    }
}
