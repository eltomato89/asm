export type ThirdPartyPackage = {
  name: string;
  version: string;
  license: string;
  homepage?: string;
  texts: { file: string; text: string }[];
  components?: string[];
};
export function packageRootOf(file: string): string | null;
export function readPackage(dir: string): ThirdPartyPackage;
export function collectFromFiles(files: Iterable<string>, cwd?: string): ThirdPartyPackage[];
export function collectFromDirs(dirs: Iterable<string>): ThirdPartyPackage[];
export function collectFromNodeModules(nodeModules: string): ThirdPartyPackage[];
export function renderNotices(title: string, packages: ThirdPartyPackage[]): string;
export function writeNotices(outFile: string, title: string, packages: ThirdPartyPackage[]): number;
export function parseNotices(text: string): ThirdPartyPackage[];
export function mergeComponents(lists: { label: string; packages: ThirdPartyPackage[] }[]): ThirdPartyPackage[];
