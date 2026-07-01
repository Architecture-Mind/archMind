# Release Process

Quy trình release cho ArchMind monorepo. Áp dụng cho CLI, các parser packages, và protocol.

---

## 1. Quyết định version bump

Dùng [Semantic Versioning](https://semver.org/):

| Loại thay đổi | Ví dụ | Bump |
|---------------|-------|------|
| Breaking change (IR schema, CLI flags, public API) | xóa field trong protocol, đổi tên command | **MAJOR** `x.0.0` |
| Feature mới backward-compatible | thêm parser framework, thêm detector | **MINOR** `0.x.0` |
| Bugfix, performance, refactor nội bộ | fix JSON truncation, fix path resolution | **PATCH** `0.0.x` |

**Nguyên tắc packages phụ thuộc nhau:**
- `protocol` bump → phải bump tất cả packages dùng nó (`explainer`, parsers, `graph-query`, CLI)
- `explainer` bump → bump CLI
- Parser packages (`laravel-parser`, `nestjs-parser`, `springboot-parser`) → bump CLI nếu thêm feature

---

## 2. Cập nhật CHANGELOG.md

Nếu chưa có `CHANGELOG.md`, tạo mới với cấu trúc:

```markdown
# Changelog

## [Unreleased]

## [0.5.0] - 2026-07-01
### Added
- Spring Boot parser: SecurityFilterChain auth + base-class path inheritance
- `archmind visualize` — Execution Timeline HTML report
### Fixed
- `findings --json` stdout truncation on large projects (process.exit race)
### Changed
- GraphQuery API: added toNodes()/fromNodes()/byId()/byIds()/toMap()
```

**Quy tắc sections:**
- `Added` — feature mới
- `Changed` — thay đổi behavior hiện có (non-breaking)
- `Deprecated` — sắp bị xóa
- `Removed` — đã xóa
- `Fixed` — bug fix
- `Security` — fix lỗ hổng bảo mật

---

## 3. Cập nhật README.md

Chỉ cần update README khi có **feature lớn** ảnh hưởng đến người dùng mới:

| Trường hợp | Cần update README? |
|------------|-------------------|
| Thêm framework mới (Spring Boot, Rails...) | ✅ Thêm vào phần "Supported Frameworks" |
| Thêm CLI command mới (`visualize`, `trace`...) | ✅ Thêm ví dụ vào phần "Usage" |
| Breaking change CLI flags hoặc output format | ✅ Update ví dụ lệnh |
| Bugfix, refactor nội bộ, thêm detector | ❌ Không cần |
| Thêm GraphQuery method (`toNodes`, `byId`...) | ❌ Không cần (internal API) |

**Các section thường update:**
- `Supported Frameworks` — khi thêm parser mới
- `CLI Commands` — khi thêm/đổi command
- Bảng so sánh benchmark — khi có số liệu mới

---

## 4. Bump version numbers

### Packages cần bump theo loại release

**Release CLI + Parsers (phổ biến nhất):**
```bash
# apps/cli/package.json
# packages/springboot-parser/package.json  (nếu có thay đổi)
# packages/nestjs-parser/package.json      (nếu có thay đổi)
# packages/laravel-parser/package.json     (nếu có thay đổi)
```

**Release Protocol (ít phổ biến, breaking):**
```bash
# packages/protocol/package.json
# + cập nhật peerDependencies ở TẤT CẢ packages dùng protocol
```

**Cách bump thủ công** — edit `version` field trong từng `package.json`:
```json
{
  "version": "0.5.0"
}
```

---

## 5. Tạo PR

```bash
# Đảm bảo branch hiện tại không phải main
git checkout -b release/v0.5.0

# Stage tất cả thay đổi release
git add CHANGELOG.md README.md apps/cli/package.json packages/*/package.json

git commit -m "chore: release v0.5.0"

# Push và tạo PR
git push -u origin release/v0.5.0

gh pr create \
  --title "release: v0.5.0" \
  --body "$(cat <<'EOF'
## Release v0.5.0

### What's changed
- Spring Boot parser: SecurityFilterChain auth + base-class path inheritance (#X)
- `archmind visualize` — Execution Timeline HTML report (#X)
- Fix: `findings --json` stdout truncation (#X)

### Packages bumped
- `@kidkender/archmind-cli` 0.4.0 → 0.5.0
- `@kidkender/archmind-springboot-parser` 0.1.0 → 0.2.0

### Checklist
- [ ] CHANGELOG.md updated
- [ ] README.md updated (nếu có feature lớn)
- [ ] Version numbers bumped
- [ ] Build passes (`npm run build`)
- [ ] Smoke test trên real project (`archmind trace --project ...`)
EOF
)"
```

---

## 6. Sau khi PR merge — tạo Git tag và GitHub Release

```bash
# Sau khi PR được merge vào main
git checkout main
git pull origin main

# Tạo annotated tag
git tag -a v0.5.0 -m "release: v0.5.0

- Spring Boot parser: SecurityFilterChain auth + base-class path inheritance
- archmind visualize — Execution Timeline HTML report
- Fix: findings --json stdout truncation"

git push origin v0.5.0

# Tạo GitHub Release từ tag
gh release create v0.5.0 \
  --title "v0.5.0 — Spring Boot + Visualizer" \
  --notes-file <(sed -n '/## \[0.5.0\]/,/## \[0.4/p' CHANGELOG.md | head -n -1)
```

**Hoặc dùng `--generate-notes`** nếu không muốn viết tay:
```bash
gh release create v0.5.0 --title "v0.5.0" --generate-notes
```

---

## 7. Publish lên npm (nếu cần)

```bash
# Build tất cả packages
npm run build --workspaces

# Publish từng package (chỉ những package có thay đổi)
cd packages/springboot-parser && npm publish --access public
cd apps/cli && npm publish --access public
```

> **Lưu ý:** Chỉ publish khi có thay đổi thực sự. Không publish minor refactor.

---

## Checklist tổng hợp

```
Release v?.?.?
--------------
[ ] 1. Xác định loại bump (major / minor / patch)
[ ] 2. Cập nhật CHANGELOG.md
[ ] 3. Cập nhật README.md (chỉ khi feature lớn)
[ ] 4. Bump version trong package.json của các package liên quan
[ ] 5. Build + smoke test: archmind trace --project <real-project>
[ ] 6. Tạo branch release/vX.Y.Z và commit
[ ] 7. Tạo PR với title "release: vX.Y.Z"
[ ] 8. Sau khi merge: git tag -a vX.Y.Z và git push origin vX.Y.Z
[ ] 9. Tạo GitHub Release từ tag
[ ] 10. Publish npm (nếu cần)
```
