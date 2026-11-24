fn main() {
    let default = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("../generated");
    let runtime = std::env::var_os("DC_DESKTOP_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or(default);
    println!("cargo:rerun-if-env-changed=DC_DESKTOP_RUNTIME_DIR");
    println!(
        "cargo:rerun-if-changed={}",
        runtime.join("runtime.tar.gz").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        runtime.join("runtime.id").display()
    );
    println!("cargo:rustc-env=DC_PACKAGED_RUNTIME={}", runtime.display());
    tauri_build::build();
}
