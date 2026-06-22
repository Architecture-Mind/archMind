/**
 * Convert mysql-schema.sql → SQLite-compatible schema for laravel-io corpus.
 * Strips MySQL-specific syntax; handles FK constraints, indexes, AUTO_INCREMENT.
 */

import { readFileSync, writeFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")

const src = join(ROOT, "research/corpus/laravel-io/database/schema/mysql-schema.sql")
const dst = join(ROOT, "research/corpus/laravel-io/database/schema/sqlite-schema.sql")

const mysql = readFileSync(src, "utf-8")

// Extract CREATE TABLE blocks
const tableBlocks = []
const tableRe = /CREATE TABLE `(\w+)`\s*\(([^;]+)\);/gs
let m
while ((m = tableRe.exec(mysql)) !== null) {
  tableBlocks.push({ name: m[1], body: m[2] })
}

function convertTableBody(name, body) {
  const lines = body.split("\n").map(l => l.trim()).filter(Boolean)
  const kept = []

  for (const line of lines) {
    // Skip MySQL-specific index declarations and constraint lines inside CREATE TABLE
    if (/^(UNIQUE KEY|KEY|CONSTRAINT)\s+/.test(line)) continue
    if (/^PRIMARY KEY\s*\(`/.test(line)) {
      // Keep PRIMARY KEY but strip backticks and MySQL options
      kept.push(line.replace(/`/g, '"').replace(/,?\s*$/, ""))
      continue
    }

    let l = line
    // Remove trailing comma from last column before closing
    // Strip backtick identifiers
    l = l.replace(/`/g, '"')
    // Remove MySQL column options
    l = l.replace(/CHARACTER SET \S+/gi, "")
    l = l.replace(/COLLATE \S+/gi, "")
    l = l.replace(/\bCOMMENT '[^']*'/gi, "")
    // MySQL types → SQLite
    l = l.replace(/\bunsigned\b/gi, "")
    l = l.replace(/\bAUTO_INCREMENT\b/gi, "")
    l = l.replace(/\btinyint\(\d+\)\b/gi, "INTEGER")
    l = l.replace(/\bsmallint\b/gi, "INTEGER")
    l = l.replace(/\bbigint\b/gi, "INTEGER")
    l = l.replace(/\bint\b/gi, "INTEGER")
    l = l.replace(/\blongtext\b/gi, "TEXT")
    l = l.replace(/\bdatetime\b/gi, "TEXT")
    l = l.replace(/\btimestamp\b/gi, "TEXT")
    l = l.replace(/\bjson\b/gi, "TEXT")
    l = l.replace(/\bvarchar\(\d+\)\b/gi, "TEXT")
    l = l.replace(/\bchar\(\d+\)\b/gi, "TEXT")
    // Clean up multiple spaces
    l = l.replace(/\s{2,}/g, " ").trim()
    // Remove empty lines
    if (!l || l === ",") continue
    kept.push(l)
  }

  // Remove trailing comma from last real column
  for (let i = kept.length - 1; i >= 0; i--) {
    if (kept[i].endsWith(",")) {
      kept[i] = kept[i].slice(0, -1)
      break
    }
  }

  return kept.join(",\n  ")
}

const stmts = []

// Add pragma
stmts.push("PRAGMA foreign_keys = OFF;")
stmts.push("")

for (const { name, body } of tableBlocks) {
  const converted = convertTableBody(name, body)
  stmts.push(`CREATE TABLE IF NOT EXISTS "${name}" (\n  ${converted}\n);`)
}

// Add migrations table rows (so Laravel knows schema is loaded)
stmts.push("")
stmts.push(`INSERT OR IGNORE INTO "migrations" ("id", "migration", "batch") VALUES`)

const migrationValues = [
  [1,"2013_09_17_113019_create_users_table"],
  [11,"2013_09_22_163103_create_articles_table"],
  [12,"2013_09_22_163347_create_tags_table"],
  [26,"2014_01_27_135001_forum_threads_create_table"],
  [27,"2014_01_27_141317_forum_replies_create_table"],
  [52,"2020_01_09_193921_create_notifications_table"],
  [68,"2019_12_14_000001_create_personal_access_tokens_table"],
  [78,"2023_01_31_190506_add_allowed_notifications_column_to_users_table"],
].map(([id, name]) => `(${id},'${name}',1)`)

stmts.push(migrationValues.join(",\n") + ";")

writeFileSync(dst, stmts.join("\n"))
console.log(`Written ${stmts.length} statements to ${dst}`)
console.log(`Tables converted: ${tableBlocks.map(t => t.name).join(", ")}`)
