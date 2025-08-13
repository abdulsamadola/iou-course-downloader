const puppeteer = require('puppeteer')
const fs = require('fs')
const path = require('path')

function parseCliArg(args, name, fallback) {
  const index = args.indexOf(`--${name}`)
  if (index !== -1 && typeof args[index + 1] === 'string') {
    return args[index + 1]
  }
  const envValue = process.env[name.toUpperCase()]
  return envValue !== undefined ? envValue : fallback
}

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return fallback
  const v = value.toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(v)) return true
  if (['0', 'false', 'no', 'n'].includes(v)) return false
  return fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function retry(fn, options = {}) {
  const {
    attempts = 3,
    initialDelayMs = 1000,
    backoffFactor = 2,
    onError,
  } = options
  let lastError
  let delay = initialDelayMs
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i)
    } catch (err) {
      lastError = err
      if (typeof onError === 'function') {
        try {
          onError(err, i)
        } catch (_) {}
      }
      if (i < attempts) await sleep(delay)
      delay *= backoffFactor
    }
  }
  throw lastError
}

async function navigateWithRetries(page, url, options = {}) {
  const {
    attempts = 3,
    timeout = 90000,
    waitUntil = 'domcontentloaded',
  } = options
  return retry(
    () =>
      page.goto(url, {
        waitUntil,
        timeout,
      }),
    {
      attempts,
      initialDelayMs: 1500,
      backoffFactor: 2,
      onError: (err, i) => {
        console.warn(
          `Navigation attempt ${i} failed for ${url}: ${err.message}`
        )
      },
    }
  )
}

;(async () => {
  const args = process.argv.slice(2)

  const username = parseCliArg(args, 'username', 'myusername')
  const password = parseCliArg(args, 'password', 'mypassword')
  const courseUrl = parseCliArg(
    args,
    'course',
    'https://campus.iou.edu.gm/campus/course/view.php?id=316'
  )
  const lecturesRaw = parseCliArg(args, 'lectures', '[]')
  const headlessArg = parseCliArg(args, 'headless', 'false')
  const slowMoArg = parseCliArg(args, 'slowmo', '0')
  const headless = toBool(headlessArg, false)
  const slowMo = Number.isFinite(Number(slowMoArg)) ? Number(slowMoArg) : 0

  function expandLectureSpecifiers(spec) {
    if (typeof spec !== 'string') return []
    const parts = spec
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    const results = []
    for (const part of parts) {
      const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/)
      const singleMatch = part.match(/^(\d+)$/)
      if (rangeMatch) {
        let start = Number(rangeMatch[1])
        let end = Number(rangeMatch[2])
        if (Number.isFinite(start) && Number.isFinite(end)) {
          if (start > end) [start, end] = [end, start]
          for (let i = start; i <= end; i++) {
            results.push(`Lecture ${i}`)
          }
        }
        continue
      }
      if (singleMatch) {
        const n = Number(singleMatch[1])
        if (Number.isFinite(n)) results.push(`Lecture ${n}`)
        continue
      }
      results.push(part)
    }
    return results
  }

  let lectureTitles = []
  try {
    const parsed = JSON.parse(lecturesRaw)
    if (Array.isArray(parsed)) {
      lectureTitles = parsed
    }
  } catch (_) {
    // If not valid JSON, allow numeric, range, and comma-separated fallbacks
    if (typeof lecturesRaw === 'string' && lecturesRaw.trim().length > 0) {
      lectureTitles = expandLectureSpecifiers(lecturesRaw)
    }
  }

  const browser = await puppeteer.launch({ headless, slowMo })
  const page = await browser.newPage()
  page.setDefaultNavigationTimeout(120000)
  page.setDefaultTimeout(60000)

  // Set up download behavior
  const downloadPath = path.resolve(__dirname, 'downloads')
  if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath)
  await page._client().send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadPath,
  })

  // Access login page
  await navigateWithRetries(
    page,
    'https://campus.iou.edu.gm/campus/auth/iouauth/login.php',
    { attempts: 3, timeout: 90000, waitUntil: 'domcontentloaded' }
  )

  await page.type('input[name="username"]', username)
  await page.type('input[name="password"]', password)
  // Submit and tolerate slow redirects. Race navigation with a DOM check.
  await page.click('button[type="submit"]')
  try {
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }),
      page.waitForSelector(
        'a[href*="courses.php"], li.section.course-section',
        {
          timeout: 90000,
        }
      ),
    ])
  } catch (e) {
    console.warn(
      'Login post-submit wait timed out; proceeding to course page...'
    )
  }

  console.log('Login successful')

  // Go directly to the course page
  await navigateWithRetries(page, courseUrl, {
    attempts: 3,
    timeout: 120000,
    waitUntil: 'domcontentloaded',
  })
  console.log('Opened course page:', courseUrl)

  // Ensure sections are present (some pages lazy-load)
  try {
    await page.waitForSelector('li.section.course-section', { timeout: 90000 })
  } catch (e) {
    console.warn('Course sections did not appear in time; continuing anyway...')
  }

  // Collect links to video pages grouped by lecture section
  const lectureVideoPages = await page.evaluate((lectureTitlesIn) => {
    const normalize = (s) => (s || '').toLowerCase().trim()
    const targetTitles = (Array.isArray(lectureTitlesIn) ? lectureTitlesIn : [])
      .map((t) => normalize(t))
      .filter((t) => t.length > 0)

    const sectionNodes = Array.from(
      document.querySelectorAll('li.section.course-section')
    )

    const results = []

    for (const section of sectionNodes) {
      const titleEl = section.querySelector('h3.sectionname')
      const sectionTitle = titleEl ? titleEl.textContent.trim() : ''
      const sectionTitleNorm = normalize(sectionTitle)

      const matchesLecture =
        targetTitles.length > 0
          ? targetTitles.some((t) => sectionTitleNorm.includes(t))
          : /lecture/.test(sectionTitleNorm)

      if (!matchesLecture) continue

      // Find "Page" type activities (video pages) within this section
      const pageItems = Array.from(
        section.querySelectorAll(
          'li.activity.activity-wrapper.modtype_page a.aalink'
        )
      )

      for (const anchor of pageItems) {
        const href = anchor.getAttribute('href') || ''
        const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim()

        // Skip if not a video-related page by title
        const isVideoTitle = /video/i.test(text)
        if (!href || !isVideoTitle) continue

        results.push({ lecture: sectionTitle, itemTitle: text, href })
      }
    }

    return results
  }, lectureTitles)

  if (!lectureVideoPages || lectureVideoPages.length === 0) {
    console.log('No matching lecture video pages found.')
    await browser.close()
    return
  }

  console.log(
    `Found ${lectureVideoPages.length} video page(s) across lectures.`
  )

  const lectureToVideoUrls = new Map()

  for (const item of lectureVideoPages) {
    const videoPage = await browser.newPage()
    videoPage.setDefaultNavigationTimeout(120000)
    videoPage.setDefaultTimeout(60000)
    try {
      await navigateWithRetries(videoPage, item.href, {
        attempts: 3,
        timeout: 120000,
        waitUntil: 'domcontentloaded',
      })

      // Attempt to reveal dropdown if it's hidden
      try {
        await videoPage.click('#dlLinks', { delay: 50 })
        await videoPage.waitForSelector('a.dropdown-item', { timeout: 5000 })
      } catch (_) {
        // ignore if not clickable; links may already be visible
      }

      const downloadUrl = await videoPage.evaluate(() => {
        const findDropdownItems = () =>
          Array.from(document.querySelectorAll('a.dropdown-item'))

        const anchors = findDropdownItems()
        if (!anchors || anchors.length === 0) return null

        const textOf = (a) => (a.textContent || '').toLowerCase().trim()

        // Prefer HD High Quality, fall back to SD Normal
        const hd = anchors.find((a) =>
          /hd|high\s*quality|720p|1080p/.test(textOf(a))
        )
        const sd = anchors.find((a) =>
          /sd|normal|240p|360p|480p/.test(textOf(a))
        )

        return (hd && hd.href) || (sd && sd.href) || null
      })

      if (downloadUrl) {
        if (!lectureToVideoUrls.has(item.lecture)) {
          lectureToVideoUrls.set(item.lecture, [])
        }
        lectureToVideoUrls.get(item.lecture).push({
          title: item.itemTitle,
          url: downloadUrl,
        })
        console.log(`Fetched: ${item.itemTitle} -> ${downloadUrl}`)
      } else {
        console.warn(`No download link found on page: ${item.itemTitle}`)
      }
    } catch (err) {
      console.warn(`Failed to process ${item.itemTitle}:`, err.message)
    } finally {
      await videoPage.close()
    }
  }

  // Output grouped URLs for download manager
  const extractLectureNumber = (title) => {
    if (typeof title !== 'string') return Number.NaN
    const byKeyword = title.match(/lecture\s*(\d+)/i)
    if (byKeyword && byKeyword[1]) return Number(byKeyword[1])
    const anyNum = title.match(/(\d+)/)
    return anyNum ? Number(anyNum[1]) : Number.NaN
  }

  const groups = []
  for (const [lecture, entries] of lectureToVideoUrls.entries()) {
    const num = extractLectureNumber(lecture)
    groups.push({ num, entries, original: lecture })
  }
  groups.sort((a, b) => {
    const an = Number.isFinite(a.num) ? a.num : Number.POSITIVE_INFINITY
    const bn = Number.isFinite(b.num) ? b.num : Number.POSITIVE_INFINITY
    if (an !== bn) return an - bn
    return a.original.localeCompare(b.original)
  })

  const lines = []
  for (const g of groups) {
    const header = Number.isFinite(g.num) ? `Lecture ${g.num}` : g.original
    lines.push(`# ${header}`)
    for (const e of g.entries) {
      lines.push(e.url)
    }
    lines.push('')
  }

  const output = lines.join('\n')
  console.log('\nVideo download URLs (grouped by lecture):\n')
  console.log(output)

  // Save to file
  const outFile = path.join(downloadPath, 'video-urls.txt')
  fs.writeFileSync(outFile, output, 'utf8')
  console.log('Saved URLs to:', outFile)

  await browser.close()
})()
