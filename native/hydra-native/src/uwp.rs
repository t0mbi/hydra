//! Launches Microsoft Store / Xbox app games via the same mechanism Windows
//! Explorer itself uses for their shortcuts (and the one the open-source
//! UWPHook project pioneered for exactly this "add UWP games to a game
//! launcher" use case): the `IApplicationActivationManager` COM interface's
//! `ActivateApplication` method. These apps have no conventional `.exe`
//! target -- Windows resolves them purely by an "AppUserModelID" string.
//!
//! `windows-sys` doesn't generate bindings for this specific interface (it's
//! absent from the standard Win32 metadata windows-rs is built from), so its
//! vtable is declared by hand here, matching the well-documented COM ABI:
//! IID `2e941141-7f97-4756-ba1d-9decde894a3d`, CLSID
//! `45ba127d-10a8-46ea-8ab7-56ea9078943c`. Only `ActivateApplication` (the
//! first custom method after the inherited `IUnknown` ones) is declared --
//! the other two methods on the real interface (`ActivateForFile`,
//! `ActivateForProtocol`) are irrelevant here and simply never get called,
//! which is safe: a `#[repr(C)]` prefix of a vtable is layout-compatible as
//! long as nothing past the declared fields is touched.

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;

    use windows_sys::core::{GUID, HRESULT, IUnknown_Vtbl, PCWSTR};
    use windows_sys::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_LOCAL_SERVER,
        COINIT_APARTMENTTHREADED,
    };

    const S_OK: HRESULT = 0;
    const S_FALSE: HRESULT = 1;
    const RPC_E_CHANGED_MODE: HRESULT = 0x8001_0106u32 as i32;

    const CLSID_APPLICATION_ACTIVATION_MANAGER: GUID =
        GUID::from_u128(0x45ba127d_10a8_46ea_8ab7_56ea9078943c);
    const IID_APPLICATION_ACTIVATION_MANAGER: GUID =
        GUID::from_u128(0x2e941141_7f97_4756_ba1d_9decde894a3d);

    const AO_NONE: i32 = 0;

    #[repr(C)]
    struct IApplicationActivationManager_Vtbl {
        base: IUnknown_Vtbl,
        activate_application: unsafe extern "system" fn(
            this: *mut c_void,
            app_user_model_id: PCWSTR,
            arguments: PCWSTR,
            options: i32,
            out_process_id: *mut u32,
        ) -> HRESULT,
    }

    fn to_pcwstr(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn activate_uwp_app(app_user_model_id: &str, arguments: &str) -> Result<u32, String> {
        unsafe {
            let init_hr = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
            let we_initialized = init_hr == S_OK || init_hr == S_FALSE;

            if init_hr != S_OK && init_hr != S_FALSE && init_hr != RPC_E_CHANGED_MODE {
                return Err(format!("CoInitializeEx failed: {init_hr:#x}"));
            }

            let result = (|| {
                let mut interface_ptr: *mut c_void = std::ptr::null_mut();

                let hr = CoCreateInstance(
                    &CLSID_APPLICATION_ACTIVATION_MANAGER,
                    std::ptr::null_mut(),
                    CLSCTX_LOCAL_SERVER,
                    &IID_APPLICATION_ACTIVATION_MANAGER,
                    &mut interface_ptr,
                );

                if hr != S_OK || interface_ptr.is_null() {
                    return Err(format!("CoCreateInstance failed: {hr:#x}"));
                }

                let vtable = *(interface_ptr as *mut *const IApplicationActivationManager_Vtbl);

                let aumid_wide = to_pcwstr(app_user_model_id);
                let args_wide = to_pcwstr(arguments);
                let mut process_id: u32 = 0;

                let activate_hr = ((*vtable).activate_application)(
                    interface_ptr,
                    aumid_wide.as_ptr(),
                    args_wide.as_ptr(),
                    AO_NONE,
                    &mut process_id,
                );

                ((*vtable).base.Release)(interface_ptr);

                if activate_hr != S_OK {
                    return Err(format!("ActivateApplication failed: {activate_hr:#x}"));
                }

                Ok(process_id)
            })();

            if we_initialized {
                CoUninitialize();
            }

            result
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn activate_uwp_app(_app_user_model_id: &str, _arguments: &str) -> Result<u32, String> {
        Err("Microsoft Store app activation is only available on Windows".to_string())
    }
}

pub use platform::activate_uwp_app;
