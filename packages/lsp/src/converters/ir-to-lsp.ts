import { pathToFileURL, fileURLToPath } from "url"
import { normalize } from "path"

export function fileToUri(filePath: string): string {
  return pathToFileURL(normalize(filePath)).toString()
}

export function uriToFile(uri: string): string {
  try {
    return fileURLToPath(uri)
  } catch {
    // fallback for non-file URIs
    return uri.replace(/^file:\/\//, "")
  }
}
