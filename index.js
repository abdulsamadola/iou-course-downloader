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

  let lectureTitles = []
  try {
    const parsed = JSON.parse(lecturesRaw)
    if (Array.isArray(parsed)) {
      lectureTitles = parsed
    }
  } catch (_) {
    // If not valid JSON, allow a comma-separated list as a fallback
    if (typeof lecturesRaw === 'string' && lecturesRaw.trim().length > 0) {
      lectureTitles = lecturesRaw.split(',').map((t) => t.trim())
    }
  }

  const browser = await puppeteer.launch({ headless: false })
  const page = await browser.newPage()

  // Set up download behavior
  const downloadPath = path.resolve(__dirname, 'downloads')
  if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath)
  await page._client().send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadPath,
  })

  // Access login page
  await page.goto('https://campus.iou.edu.gm/campus/auth/iouauth/login.php', {
    waitUntil: 'networkidle2',
  })

  await page.type('input[name="username"]', username)
  await page.type('input[name="password"]', password)
  await Promise.all([
    page.click('button[type="submit"]'),
    page.waitForNavigation({ waitUntil: 'networkidle2' }),
  ])

  console.log('Login successful')

  // Go directly to the course page
  await page.goto(courseUrl, { waitUntil: 'networkidle2' })
  console.log('Opened course page:', courseUrl)

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
    try {
      await videoPage.goto(item.href, { waitUntil: 'networkidle2' })

      // Attempt to reveal dropdown if it's hidden
      try {
        await videoPage.click('#dlLinks', { delay: 50 })
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
  const lines = []
  for (const [lecture, entries] of lectureToVideoUrls.entries()) {
    lines.push(`# ${lecture}`)
    for (const e of entries) {
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
