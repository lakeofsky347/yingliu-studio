export function assertHostTarget(platform: string, arch: string, hostPlatform?: string, hostArch?: string): void;
export function parsePackageOptions(args: string[], allowVerification?: boolean): { platform: string; arch: string; layoutOnly: boolean; bundle?: string; help: boolean };
export function packageLayout(root: string, platform?: string, arch?: string): {
  name: string; platform: string; arch: string; destination: string; appRelative: string; executableRelative: string;
  launcherRelative: string; manifestRelative: string; electronExecutable: string;
};
export function probeElectron(executable: string, script: string, args?: string[]): string;
export function electronRuntime(executable: string): {platform: string; arch: string; electron?: string};
export function copyApplication(root: string, appRoot: string): Promise<{name: string; productName: string; version: string; main: string; license: string}>;
export function assertRelativeSymlinks(directory: string): Promise<void>;
export const linuxLauncher: string;
export const linuxDesktopInstaller: string;
export const linuxDesktopWriter: string;
