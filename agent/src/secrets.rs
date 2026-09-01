use anyhow::{Context, Result};
use base64::Engine;

#[cfg(windows)]
pub fn protect_secret(secret: &str) -> Result<String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    };

    let bytes = secret.as_bytes();
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let succeeded = unsafe {
        CryptProtectData(
            &mut input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if succeeded == 0 {
        anyhow::bail!("Windows DPAPI could not protect the device token");
    }
    let protected = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let encoded = base64::engine::general_purpose::STANDARD.encode(protected);
    unsafe {
        LocalFree(output.pbData as *mut core::ffi::c_void);
    }
    Ok(encoded)
}

#[cfg(windows)]
pub fn unprotect_secret(encoded: &str) -> Result<String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
    };

    let mut protected = base64::engine::general_purpose::STANDARD.decode(encoded)?;
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: protected.len() as u32,
        pbData: protected.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let succeeded = unsafe {
        CryptUnprotectData(
            &mut input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if succeeded == 0 {
        anyhow::bail!("Windows DPAPI could not decrypt the device token");
    }
    let plaintext = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let secret = String::from_utf8(plaintext.to_vec()).context("device token was not UTF-8")?;
    unsafe {
        LocalFree(output.pbData as *mut core::ffi::c_void);
    }
    Ok(secret)
}

#[cfg(not(windows))]
pub fn protect_secret(secret: &str) -> Result<String> {
    Ok(base64::engine::general_purpose::STANDARD.encode(secret))
}

#[cfg(not(windows))]
pub fn unprotect_secret(encoded: &str) -> Result<String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded)?;
    String::from_utf8(bytes).context("protected token was not UTF-8")
}
