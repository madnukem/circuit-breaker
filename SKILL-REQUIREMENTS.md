# SKILL REQUIREMENTS — QA Checklist

Обязательный чек-лист для пакета. Любой пункт FAIL = пакет нельзя публиковать.

Выведен из postmortem инцидента `INCIDENT-2026-06-15-tdd-workflow-unknown.md`
(`lazy-skill-loader`): скилл прошёл все тесты в dev-окружении, но упал в проде,
потому что `npm pack` не включил `hooks/`/`lib/`/`registry/`, и `Skill` tool не
смог резолвить ID. Корневая причина — тесты проверяли структуру JSON, но не
существование файлов; тесты跑али из исходного репо, а не из установленного
payload; hook и `Skill` tool использовали разные источники правды.

---

## Структурные требования

### C1. `SKILL.md` в корне с валидным frontmatter
- Файл `SKILL.md` лежит в **корне** пакета.
- Начинается YAML frontmatter с полями `name` и `description`.
- `name` совпадает с именем каталога и callable через `Skill(name)`.
- Если `SKILL.md` лежит в `skills/<name>/SKILL.md` — это баг: после `npm pack`
  без поля `files` файл не попадёт в tarball.

### C2. `package.json` содержит поле `files`
- Поле `"files": [...]` явно перечисляет включаемые ресурсы.
- Минимум: `["hooks", "lib", "package.json", "README.md"]`.
- Если есть `registry/`, `skills/`, `core/` — они тоже в списке.
- **Без `files`** `npm pack` по умолчанию кладёт в tarball только
  `package.json`/`README.md`/`LICENSE`/`*.js` в корне. Каталоги `hooks/`,
  `lib/`, `registry/`, `skills/` выкидываются. Это и есть корневая причина
  инцидента.

### C3. Пути в manifest/registry ведут к существующим файлам
- Если есть `registry/*.json`, `skills/*/manifest.json` или иной manifest —
  каждый `path`/`source`/`href` внутри **резолвится в существующий файл** в репо.
- Валидация должна вызывать `fs.existsSync`, а не просто проверять формат строки
  (отсутствие `..`, отсутствие абсолютного пути — недостаточно).

### C4. Hook резолвит пути через `__dirname`
- OK: `require('../lib/...')`, `path.join(__dirname, '...')`,
  `path.join(os.homedir(), '.claude', ...)`.
- **НЕ OK**: `path.resolve(process.cwd(), ...)`, абсолютные хардкоды путей
  разработчика (`C:/Users/Vassa/...`).
- Path traversal через `..` для выхода за пределы пакета — отбрасывается
  валидатором.

### C5. Тесты проверяют реальные файлы репо
- Хотя бы один тест делает `require('../registry/...')` или
  `fs.existsSync('<real path>')` для production-данных, не только для
  in-memory fixtures.
- Тесты, которые сами генерируют тестовые данные через `writeRegistry` в temp,
  могут пропускать сломанные пути в production registry.

### C6. Integration test: hook запускается из temp-директории
- Тест копирует пакет (или распаковывает `npm pack` `.tgz`) во временную
  директорию и запускает hook оттуда.
- Ловит ситуации «работает в dev, падает в prod с `MODULE_NOT_FOUND`».

### C7. README описывает установку корректно
- Указан целевой путь (`~/.claude/skills/<name>/` или эквивалент).
- Перечислены **все** ресурсы для копирования — не только `SKILL.md`.
- Указано, что и где регистрировать в `settings.json` (hook config, env vars).

### C8. `npm test` проходит
- Без предупреждений о missing modules.
- Без skip'нутых тестов без объяснения причины.
- Все под-тесты в `scripts.test` выполняются.

### C9. `.gitignore` не блокирует ресурсы установки
- `node_modules/`, `*.log`, `.temp-*` — игнорируются.
- `hooks/`, `lib/`, `registry/`, `skills/` — **не** в ignore.
- Отсутствие `.gitignore` — FAIL: риск случайной утечки sensitive данных.

---

## Обязательные тесты, которых часто нет

### T1. Payload completeness test
Проверяет, что `npm pack` действительно кладёт нужные каталоги в tarball.
Единственный тест, который надёжно ловит дефект инцидента.

```js
// tests/payload.test.js
const { execSync } = require('child_process');
const { test, assert } = require('./helpers');

test('npm pack contains hooks/ and lib/', () => {
  const out = execSync('npm pack --dry-run --json',
    { cwd: __dirname + '/..' }).toString();
  const files = JSON.parse(out)[0].files.map(f => f.path);
  assert(files.some(f => f.startsWith('hooks/')),
    'hooks/ missing from tarball');
  assert(files.some(f => f.startsWith('lib/')),
    'lib/ missing from tarball');
});
```

### T2. Path existence test (если есть registry/manifest)
Проверяет, что каждый путь в manifest ведёт к существующему файлу.

```js
// tests/paths.test.js
const fs = require('fs');
const path = require('path');
const { test, assert } = require('./helpers');

test('every registry path resolves to a real file', () => {
  const reg = require('../registry/skills-registry.json');
  for (const skill of reg.skills) {
    const resolved = path.join(__dirname, '..', skill.path);
    assert(fs.existsSync(resolved),
      `Missing: ${skill.path} (referenced by ${skill.id})`);
  }
});
```

### T3. Skill ID resolvability test
ID, который рекламируется пользователю/агенту (в README, hook output,
registry), должен быть callable через `Skill(id)` в Claude Code. Никаких
частных пространств имён вроде `tdd-workflow`, которые не маппятся в реальные
`plugin:skill-id` (`superpowers:test-driven-development`).

### T4. End-to-end install test
- `npm pack` → распакуй `.tgz` во временную директорию → запусти hook оттуда →
  assert exit code 0.
- Должен быть отдельным скриптом в `scripts/test-install.sh` или
  `tests/install.test.js`.

---

## Приоритеты исправлений

| P | Пункт | Почему |
|---|---|---|
| **P0** | C2 (`files` field) | Без этого `npm pack` ломает скилл — основная причина инцидента |
| **P0** | C1 (`SKILL.md` в корне) | Без этого `Skill` tool не находит скилл |
| **P1** | C3, T2 (path existence) | Корневая причина `tdd-workflow` → Unknown skill |
| **P1** | C6, T1, T4 (payload + e2e) | Единственные тесты, которые ловят инцидент целиком |
| **P2** | C4, C5, C7, C9 | Качество и воспроизводимость |
| **P3** | C8 (`npm test` green) | Необходимо, но недостаточно |

---

## Smoke check перед публикацией

Из корня пакета:

```bash
# 1. Тесты проходят
npm test

# 2. npm pack включает нужные каталоги
npm pack --dry-run --json | grep -E '"path": "(hooks|lib|registry|skills)/'

# 3. SKILL.md существует и имеет frontmatter
test -f SKILL.md && head -1 SKILL.md

# 4. Field files присутствует в package.json
node -e "console.log(require('./package.json').files || 'MISSING')"
```

Если любая команда молчит или падает — публиковать нельзя.

---

## Известные дефекты в этой коллекции (по состоянию на 2026-06-15)

Аудит 10 пакетов в `~/skills_research/` выявил системные пробелы:

- **8 из 9 hook-based пакетов** не имеют `SKILL.md` в корне (FAIL C1).
- **9 из 9 hook-based пакетов** не имеют поля `files` в `package.json` (FAIL C2).
- **4 пакета** не имеют `.gitignore` (FAIL C9): `health-check`,
  `rate-limiting-pattern`, `retry-pattern`, `timeout-pattern`.
- **0 пакетов** не имеют теста payload completeness (FAIL T1).
- **0 пакетов** не имеют e2e install test (FAIL T4).

`lazy-skill-loader` дополнительно FAIL по C3/T2: registry ссылается на
несуществующие файлы `skills/gate-based/*/SKILL.md`.

Эти дефекты — тот же класс бага, что вызвал инцидент. Любая публикация через
`npm install` сломает скилл так же, как `tdd-workflow`.

---

## Источник

- Постмортем: `INCIDENT-2026-06-15-tdd-workflow-unknown.md` в `lazy-skill-loader/`
- Аудит коллекции: проведён 2026-06-15 на 10 пакетах `~/skills_research/`
