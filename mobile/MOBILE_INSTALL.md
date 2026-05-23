# Of Stats Editor — Mobile build

Mobile-compatible build of the extension for Orion browser (iOS / iPadOS).
PC version in the parent directory is untouched and continues to use the
chrome.scripting APIs for performance.

## Установка в Orion (iOS/iPadOS)

1. Заархивируй папку `mobile/` в `.zip`:
   - На Mac: правый клик по папке → Compress
   - Или в терминале: `cd "Plugin Stata" && zip -r mobile-build.zip mobile/`
2. Перенеси .zip на iPhone/iPad (AirDrop / iCloud Drive / email)
3. В Orion: Settings → Extensions → Install from .zip → выбери архив
4. Открой OnlyFans, тапни иконку расширения → должен открыться popup
5. Войди в аккаунт, настрой значения, нажми Apply Changes

## Что изменено vs PC версии

### manifest.json
- Убраны permissions: `scripting`, `alarms`, `sidePanel`, `system.display`
- Добавлен permission: `tabs` (нужен для chrome.tabs.sendMessage)
- Убран блок `side_panel` (на мобилке нет side panel UI)

### api-client.js (НОВЫЙ файл)
- Полная реплика API dispatch из background.js, выполняемая прямо в popup-контексте
- Monkey-patch'ит `chrome.runtime.sendMessage`: при отправке известного action
  (login, register, getModels, getPlans и ~40 других) вызывает локальный handler
  с прямым `fetch` к Railway бэкенду — **никаких round-trip'ов через service worker**
- Critical fix: на Orion mobile service worker часто не просыпается, и
  `chrome.runtime.sendMessage` зависает навсегда. Локальный fetch всегда работает.
- Подключается в popup.html ДО popup.js так что патч активен до первого вызова

### popup.js
- Все 13 вызовов `chrome.scripting.executeScript` заменены на
  `chrome.tabs.sendMessage` к новым handler'ам в content.js:
  - `pageLocalStorage` — set/get/remove/batch операции с localStorage
  - `saveSettingsToCache` — обновление ofStatsCache с условной логикой
  - `getEarningStats` / `setEarningStats` / `clearEarningStats` — preset workflow
  - `updateCachedUsername` — синхронизация username в кеше
  - `resetPageState` — полный cleanup при Reset
- Apply flow упрощён: убран `chrome.tabs.onUpdated` listener (не срабатывает
  надёжно на мобилке и вешает spinner до 15s timeout). Теперь fire-and-forget
  reload + сразу очистка UI.

### content.js
- Добавлено 6 message handler'ов под прицельные операции (см. выше)
- Логика идентична оригинальной — просто переехала из page-context в content-script

### background.js
- `chrome.system.display.getInfo` — уже было в try/catch, fallback на дефолтную позицию окна
- `chrome.sidePanel.open` — добавлена feature detection (на мобилке API отсутствует)
- `chrome.alarms` — feature detection, на мобилке token refresh идёт лениво при API запросах
- `chrome.scripting.executeScript` в `broadcastAuthStatus` — заменён на sendMessage

## Известные ограничения на мобилке

- **Side panel недоступен** — popup открывается как обычное всплывающее окно
- **Token refresh не периодический** — рефреш токена случается при первом API
  запросе после истечения, а не каждые 3 дня в фоне
- **Окно auth confirm не центрируется** — браузер сам выбирает позицию (нет
  multi-display info на мобилке)

## Maintenance

Текущая стратегия — полная копия. При изменениях в PC версии:

1. Сравни общие файлы: `diff ../inject-early.js mobile/inject-early.js`
2. Скопируй апдейты в `mobile/` для общих файлов
3. Для `manifest.json`, `popup.js`, `content.js`, `background.js` — применяй
   изменения вручную, сохраняя mobile-специфичные адаптации
