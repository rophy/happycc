import { loadAppConfig } from "./sync/appConfig";
import { resolveAppLinks } from "./utils/appLinks";

export const config = loadAppConfig();
export const appLinks = resolveAppLinks(config);

/**
 * The app only controls sessions started with `happycc` on a workstation; it
 * never starts, resumes, forks or duplicates sessions or uses machines. On
 * unless the build's config explicitly turns it off.
 */
export const workstationOnly = config.workstationOnly !== false;
