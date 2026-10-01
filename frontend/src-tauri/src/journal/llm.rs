//! Calls the user's configured summary model for journal work.

use crate::database::repositories::setting::SettingsRepository;
use crate::summary::llm_client::{generate_summary, LLMProvider};
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Client;
use sqlx::SqlitePool;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

pub struct JournalLlm {
    client: Client,
    provider: LLMProvider,
    model: String,
    api_key: String,
    ollama_endpoint: Option<String>,
    custom_endpoint: Option<String>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    top_p: Option<f32>,
    app_data_dir: Option<PathBuf>,
}

impl JournalLlm {
    /// Uses the same provider/model the user picked for meeting summaries.
    pub async fn from_settings<R: Runtime>(app: &AppHandle<R>, pool: &SqlitePool) -> Result<Self, String> {
        let setting = SettingsRepository::get_model_config(pool)
            .await
            .map_err(|e| format!("Failed to read model settings: {e}"))?
            .ok_or("No AI model is configured. Choose a summary model in Settings first.")?;

        let provider = LLMProvider::from_str(&setting.provider)?;
        let mut model = setting.model.clone();
        let mut api_key = String::new();
        let (mut custom_endpoint, mut max_tokens, mut temperature, mut top_p) = (None, None, None, None);

        match provider {
            LLMProvider::Ollama | LLMProvider::BuiltInAI => {}
            LLMProvider::CustomOpenAI => {
                let config = SettingsRepository::get_custom_openai_config(pool)
                    .await
                    .map_err(|e| format!("Failed to read custom OpenAI config: {e}"))?
                    .ok_or("Custom OpenAI provider selected but no configuration found")?;
                if model.trim().is_empty() {
                    model = config.model.clone();
                }
                custom_endpoint = Some(config.endpoint);
                api_key = config.api_key.unwrap_or_default();
                max_tokens = config.max_tokens.map(|t| t as u32);
                temperature = config.temperature;
                top_p = config.top_p;
            }
            _ => {
                api_key = SettingsRepository::get_api_key(pool, &setting.provider)
                    .await
                    .map_err(|e| format!("Failed to read API key: {e}"))?
                    .filter(|k| !k.is_empty())
                    .ok_or_else(|| format!("API key not found for {}", setting.provider))?;
            }
        }

        if model.trim().is_empty() {
            return Err("No AI model is selected. Choose a summary model in Settings first.".into());
        }

        Ok(Self {
            client: Client::new(),
            ollama_endpoint: if provider == LLMProvider::Ollama { setting.ollama_endpoint } else { None },
            provider,
            model,
            api_key,
            custom_endpoint,
            max_tokens,
            temperature,
            top_p,
            app_data_dir: app.path().app_data_dir().ok(),
        })
    }

    /// Rough number of prompt characters the model can take. Local models get
    /// a small budget so long meetings are processed in several passes.
    pub fn context_chars(&self) -> usize {
        match self.provider {
            LLMProvider::BuiltInAI | LLMProvider::Ollama => 9_000,
            LLMProvider::CustomOpenAI => 16_000,
            _ => 60_000,
        }
    }

    pub async fn complete(&self, system_prompt: &str, user_prompt: &str) -> Result<String, String> {
        let completion = generate_summary(
            &self.client,
            &self.provider,
            &self.model,
            &self.api_key,
            system_prompt,
            user_prompt,
            self.ollama_endpoint.as_deref(),
            self.custom_endpoint.as_deref(),
            self.max_tokens,
            self.temperature,
            self.top_p,
            self.app_data_dir.as_ref(),
            None,
        )
        .await?;
        Ok(strip_reasoning(&completion.content))
    }
}

static THINK_BLOCK: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)<think>.*?</think>").unwrap());

fn strip_reasoning(text: &str) -> String {
    THINK_BLOCK.replace_all(text, "").trim().to_string()
}

/// Pulls the first JSON object out of a model reply that may wrap it in prose or code fences.
pub fn extract_json_object(text: &str) -> Option<serde_json::Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    let candidate = &text[start..=end];
    serde_json::from_str(candidate).ok().or_else(|| {
        // Small models often leave trailing commas.
        static TRAILING_COMMA: Lazy<Regex> = Lazy::new(|| Regex::new(r",\s*([}\]])").unwrap());
        serde_json::from_str(&TRAILING_COMMA.replace_all(candidate, "$1")).ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_fenced_json_with_trailing_commas() {
        let reply = "Sure!\n```json\n{\"topics\": [{\"title\": \"A\",},]}\n```";
        let value = extract_json_object(reply).unwrap();
        assert_eq!(value["topics"][0]["title"], "A");
    }

    #[test]
    fn strips_think_blocks() {
        assert_eq!(strip_reasoning("<think>hmm</think>\nAnswer"), "Answer");
    }
}
