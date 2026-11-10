import path from "node:path";
import { pathToFileURL } from "node:url";

// Hooks run on a dedicated thread that inherits a copy of process.env.
const packageURL = pathToFileURL(path.resolve(process.env.MEGAMEMORY_PACKAGE_ROOT ?? "") + path.sep).href;
const anchorURL = pathToFileURL(path.join(path.resolve(process.env.MEGAMEMORY_LOCAL_DEPS ?? ""), "package.json")).href;

export function resolve(specifier, context, nextResolve) {
  const bare = !/^(?:[./\\]|[a-z][a-z0-9+.-]*:|#)/i.test(specifier);
  if (bare && context.parentURL?.startsWith(packageURL)) {
    return nextResolve(specifier, { ...context, parentURL: anchorURL });
  }
  return nextResolve(specifier, context);
}
