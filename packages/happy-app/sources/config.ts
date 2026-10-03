import { loadAppConfig } from "./sync/appConfig";
import { resolveAppLinks } from "./utils/appLinks";

export const config = loadAppConfig();
export const appLinks = resolveAppLinks(config);
