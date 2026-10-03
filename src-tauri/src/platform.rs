// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "T057 implements the platform facts, and T063 sends them"
    )
)]

use windows::Win32::System::SystemInformation::IMAGE_FILE_MACHINE;

/// The platform scope of contract §3 `getEnvironment`. No error code applies to either scope.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    QualificationTarget,
    Other,
}

impl Scope {
    /// The `platformScope` value of the startup handshake (contract §6).
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::QualificationTarget => "qualification-target",
            Scope::Other => "other",
        }
    }
}

/// The inputs of the scope decision (plan.md "Provisional prerequisite admission").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Facts {
    /// `dwBuildNumber` from `RtlGetVersion`.
    pub build: u32,
    /// `wProductType` from `RtlGetVersion`: `VER_NT_WORKSTATION`, `VER_NT_DOMAIN_CONTROLLER`, or `VER_NT_SERVER`.
    pub product_type: u8,
    /// The native machine from `IsWow64Process2`.
    pub native_machine: IMAGE_FILE_MACHINE,
}

/// `qualification-target` for build 22000 or later, `VER_NT_WORKSTATION`, and a native AMD64 machine. Otherwise `other`.
pub fn scope(_facts: Facts) -> Scope {
    todo!("T057")
}

/// Reads the facts of this host with `RtlGetVersion` and `IsWow64Process2`.
pub fn read() -> Facts {
    todo!("T057")
}

#[cfg(test)]
mod tests {
    use super::*;

    use windows::Wdk::System::SystemServices::RtlGetVersion;
    use windows::Win32::System::SystemInformation::{
        IMAGE_FILE_MACHINE_AMD64, IMAGE_FILE_MACHINE_ARM64, OSVERSIONINFOEXW, OSVERSIONINFOW,
    };
    use windows::Win32::System::SystemServices::{
        VER_NT_DOMAIN_CONTROLLER, VER_NT_SERVER, VER_NT_WORKSTATION,
    };

    const WORKSTATION: u8 = VER_NT_WORKSTATION as u8;
    const SERVER: u8 = VER_NT_SERVER as u8;
    const DOMAIN_CONTROLLER: u8 = VER_NT_DOMAIN_CONTROLLER as u8;

    fn facts(build: u32, product_type: u8, native_machine: IMAGE_FILE_MACHINE) -> Facts {
        Facts {
            build,
            product_type,
            native_machine,
        }
    }

    #[test]
    fn the_scope_values_are_the_contract_names() {
        assert_eq!(Scope::QualificationTarget.as_str(), "qualification-target");
        assert_eq!(Scope::Other.as_str(), "other");
    }

    #[test]
    fn windows_11_workstation_builds_on_native_amd64_are_the_qualification_target() {
        for build in [22000, 26200] {
            assert_eq!(
                scope(facts(build, WORKSTATION, IMAGE_FILE_MACHINE_AMD64)),
                Scope::QualificationTarget,
                "build {build}"
            );
        }
    }

    #[test]
    fn windows_10_build_19045_is_other() {
        assert_eq!(
            scope(facts(19045, WORKSTATION, IMAGE_FILE_MACHINE_AMD64)),
            Scope::Other
        );
    }

    #[test]
    fn server_and_domain_controller_product_types_are_other() {
        // Windows Server 2025 reports build 26100, so only the product type separates it.
        for product_type in [SERVER, DOMAIN_CONTROLLER] {
            assert_eq!(
                scope(facts(26100, product_type, IMAGE_FILE_MACHINE_AMD64)),
                Scope::Other,
                "product type {product_type}"
            );
        }
    }

    #[test]
    fn the_x64_build_under_emulation_on_native_arm64_is_other() {
        assert_eq!(
            scope(facts(26200, WORKSTATION, IMAGE_FILE_MACHINE_ARM64)),
            Scope::Other
        );
    }

    /// Host test: an independent `RtlGetVersion` read with the extended structure.
    #[test]
    fn the_host_facts_match_rtl_get_version() {
        let mut oracle = OSVERSIONINFOEXW {
            dwOSVersionInfoSize: size_of::<OSVERSIONINFOEXW>() as u32,
            ..Default::default()
        };
        // SAFETY: `oracle` is a live local, and its size field names the extended structure.
        let status = unsafe { RtlGetVersion((&raw mut oracle).cast::<OSVERSIONINFOW>()) };
        assert!(status.is_ok(), "RtlGetVersion");
        let host = read();
        assert_eq!(host.build, oracle.dwBuildNumber);
        assert_eq!(host.product_type, oracle.wProductType);
        // The x64 test binary runs only on a native AMD64 or ARM64 machine.
        assert!(
            [IMAGE_FILE_MACHINE_AMD64, IMAGE_FILE_MACHINE_ARM64].contains(&host.native_machine),
            "native machine {:?}",
            host.native_machine
        );
    }
}
