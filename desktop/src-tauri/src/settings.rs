use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub funnel_port: Option<u16>,
    pub callback_uri: String,
    pub close_to_tray: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            funnel_port: None,
            callback_uri: String::new(),
            close_to_tray: true,
        }
    }
}

impl Settings {
    fn validate(mut self) -> Result<Self, String> {
        if !matches!(self.funnel_port, None | Some(443 | 8443 | 10000)) {
            return Err("Choose Automatic, 443, 8443, or 10000 for the Funnel port.".into());
        }
        self.callback_uri = self.callback_uri.trim().to_owned();
        if !self.callback_uri.is_empty() {
            let valid = self
                .callback_uri
                .strip_prefix("https://chatgpt.com/connector/oauth/")
                .is_some_and(|id| {
                    !id.is_empty()
                        && id.len() <= 200
                        && id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
                });
            if !valid {
                return Err("Paste the exact https://chatgpt.com/connector/oauth/… URL shown by ChatGPT, or leave it blank.".into());
            }
        }
        Ok(self)
    }

    pub fn load(dir: &Path) -> Result<Self, String> {
        match fs::read(dir.join("settings.json")) {
            Ok(data) => serde_json::from_slice::<Self>(&data)
                .map_err(|error| error.to_string())?
                .validate(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn save(self, dir: &Path) -> Result<Self, String> {
        let settings = self.validate()?;
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(dir).map_err(|error| error.to_string())?;
        serde_json::to_writer_pretty(temporary.as_file_mut(), &settings)
            .map_err(|error| error.to_string())?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        temporary
            .persist(dir.join("settings.json"))
            .map_err(|error| error.to_string())?;
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_round_trip_and_reject_a_redirect_to_another_host() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings {
            funnel_port: Some(8443),
            callback_uri: " https://chatgpt.com/connector/oauth/sample-id ".into(),
            close_to_tray: false,
        };
        settings.save(dir.path()).unwrap();
        let saved = Settings::load(dir.path()).unwrap();
        assert_eq!(saved.funnel_port, Some(8443));
        assert_eq!(
            saved.callback_uri,
            "https://chatgpt.com/connector/oauth/sample-id"
        );
        assert!(!saved.close_to_tray);
        assert!(Settings {
            callback_uri: "https://example.com/connector/oauth/sample-id".into(),
            ..saved
        }
        .save(dir.path())
        .is_err());
        assert_eq!(Settings::load(dir.path()).unwrap().funnel_port, Some(8443));
    }
}
