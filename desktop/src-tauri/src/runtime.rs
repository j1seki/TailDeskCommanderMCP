use flate2::read::GzDecoder;
use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

static RUNTIME: &[u8] = include_bytes!(concat!(env!("DC_PACKAGED_RUNTIME"), "/runtime.tar.gz"));
const RUNTIME_ID: &str = include_str!(concat!(env!("DC_PACKAGED_RUNTIME"), "/runtime.id"));

fn unpack(source: impl Read, destination: &Path) -> io::Result<()> {
    for entry in tar::Archive::new(source).entries()? {
        let mut item = entry?;
        let kind = item.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "unsupported entry in portable runtime: {}",
                    item.path()?.display()
                ),
            ));
        }
        if !item.unpack_in(destination)? {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "bundled entry escapes the runtime directory",
            ));
        }
    }
    Ok(())
}

pub fn prepare(app: &AppHandle) -> Result<PathBuf, String> {
    let cache = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let destination = cache.join(format!("runtime-{RUNTIME_ID}"));
    let marker = destination.join(".complete");
    if marker.is_file() {
        return Ok(destination);
    }
    let staging = tempfile::tempdir_in(&cache).map_err(|e| e.to_string())?;
    unpack(GzDecoder::new(RUNTIME), staging.path())
        .map_err(|e| format!("Could not unpack the bundled server: {e}"))?;
    fs::write(staging.path().join(".complete"), b"").map_err(|e| e.to_string())?;
    if let Err(error) = fs::rename(staging.path(), &destination) {
        if !marker.is_file() {
            return Err(format!("Could not install the bundled server: {error}"));
        }
    }
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_package_unpacks_without_links() {
        let destination = tempfile::tempdir().unwrap();
        unpack(GzDecoder::new(RUNTIME), destination.path()).unwrap();
        let root = destination.path();
        assert!(root.join("node").is_file() || root.join("node.exe").is_file());
        assert!(root.join("scripts/chatgpt-mcp.mjs").is_file());
        assert!(!root
            .join("node_modules/gray-matter/node_modules/.bin")
            .exists());
    }

    #[test]
    fn a_nested_npm_symlink_is_rejected_before_extraction() {
        let mut archive = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        archive
            .append_link(
                &mut header,
                "node_modules/gray-matter/node_modules/.bin/js-yaml",
                "../js-yaml/bin/js-yaml.js",
            )
            .unwrap();
        let bytes = archive.into_inner().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let error = unpack(bytes.as_slice(), destination.path()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
