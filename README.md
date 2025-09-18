## IOU Course Video URL Extractor

### Overview

This tool automates login to the IOU campus, navigates to a specific course page, locates lecture sections, visits each “Video” page, and extracts the actual direct download URLs for videos. It prefers HD High Quality links when available, and falls back to SD Normal. The grouped URLs are printed to the console and saved to `downloads/video-urls.txt`, ready to feed into a download manager.

### Key Features

- **Automated login** using your IOU campus credentials
- **Target a specific course page** by URL
- **Filter by lectures** using:
  - numbers/ranges like `--lectures '5'` or `--lectures '1-5,8'` (exact numeric match; '1' will not match '10')
  - or an array/list of titles (e.g., `["Lecture 1", "Lecture 2"]`)
- **Video page detection** under each lecture section (items of type Page with title including “Video”)
- **HD-first extraction**: prefer “HD High Quality”, fallback to “SD Normal”
- **Grouped output** by lecture section, written to `downloads/video-urls.txt`

### Important Notes and Ethics

- **For personal/academic use** only. Respect your institution’s Terms of Service and copyright policies.
- **Do not share your credentials** or commit them to source control.
- Generated download links may be **time-limited** by the video provider (e.g., Vimeo). Download soon after generating.

### Prerequisites

- Node.js 18+ (recommended)
- macOS, Linux, or Windows
- An IOU campus account with access to the target course

### Installation

```bash
git clone <this-repo-url>
cd iou-downloader
npm install    # or: yarn install
```

### Configuration

You can pass credentials and inputs via command-line flags or environment variables.

- **Flags**

  - `--username` Your IOU campus username
  - `--password` Your IOU campus password
  - `--course` Full course URL (e.g., `https://campus.iou.edu.gm/campus/course/view.php?id=316`)
- `--lectures` One of: numeric/range spec (e.g., `'5'`, `'1-5,8'`), a comma list, or a JSON array of titles

- **Environment variables** (alternative to flags)
  - `USERNAME`, `PASSWORD`, `COURSE`, `LECTURES`

Examples for `--lectures` / `LECTURES` (exact numeric matching):

- Single lecture by number: `'5'`
- Range of lectures: `'1-5'` (matches 1 through 5 only)
- Combo of ranges and singles: `'1-3,5,7-9'`
- JSON array: `'["Lecture 1","Lecture 2"]'`
- Comma list (titles): `'Lecture 1,Lecture 2'` (falls back to title substring match)

If `--lectures`/`LECTURES` is omitted, the script defaults to sections whose title contains “lecture”.

### Usage

- Using flags:

```bash
node index.js \
  --username YOUR_USER \
  --password YOUR_PASS \
  --course "https://campus.iou.edu.gm/campus/course/view.php?id=316" \
  --lectures '1-5'
```

- Using environment variables:

```bash
USERNAME=YOUR_USER \
PASSWORD=YOUR_PASS \
COURSE="https://campus.iou.edu.gm/campus/course/view.php?id=316" \
LECTURES='1-5,8' \
node index.js
```

#### Headless vs. visible browser

The script currently launches Chromium in visible mode to make troubleshooting easy. You can switch to headless by editing `index.js` and changing the `puppeteer.launch({ headless: false })` line to `headless: true`.

### Output

- The script will print the grouped URLs and also write them to:
- `downloads/video-urls.txt`
 - The file format is simple and headers are ordered with standardized titles. If you select by numbers/ranges, only those exact lecture numbers are included:

```
# Lecture 1
https://.../video1_hd.mp4
https://.../video1b_hd.mp4

# Lecture 2
https://.../video2_sd.mp4
```

You can feed this file into your download manager. For example, with `aria2c`:

```bash
aria2c -i downloads/video-urls.txt -x 8 -s 8 -j 4
```

### How it works (selectors and matching)

- Navigates to your course page and enumerates sections matching your lecture titles.
- For each matching `li.section.course-section`, it looks for video pages under:
  - `li.activity.activity-wrapper.modtype_page a.aalink`
- It considers only pages whose link text includes “Video”.
- On each video page, it tries to open the “Download Video” dropdown (`#dlLinks`) and extracts links from `.dropdown-item` anchors, preferring labels like “HD High Quality” (720p/1080p) and falling back to “SD Normal” (240p/360p/480p).

### Customization

- If your course uses different naming (e.g., “Session 1” instead of “Lecture 1”), pass the exact section titles in `--lectures`.
- If video page titles don’t include “Video”, you can tweak the text filter in `index.js` to match your course’s naming.
- You can adjust the quality preference list by updating the HD/SD regex checks inside the extraction logic.

### Troubleshooting

- **Login fails**: Verify username/password, and ensure no 2FA prompts are blocking. Try running in visible mode (default) to observe the flow.
- **No matching lecture sections found**: Confirm your `--lectures` values match the section headings shown on the course page.
- **No video links extracted**: The page layout or selectors may have changed. Inspect the video page and update selectors in `index.js` accordingly.
- **Download links expire**: Extract and download in the same session, as URLs may include time-limited tokens.
- **Blocked by site or rate-limits**: Add small delays, reduce concurrency (the script visits pages sequentially by default), or run during off-peak hours.

### Security

- Avoid hard-coding credentials. Prefer environment variables or flags.
- Do not commit your credentials or `downloads/video-urls.txt` if it contains sensitive links.

### Contributing

Contributions are welcome! Feel free to open issues or submit pull requests to improve selectors, add features (e.g., parallel extraction, retries), or support additional course layouts.

### License

Add your preferred license (e.g., MIT) to a `LICENSE` file. If you’re unsure, MIT is a simple permissive choice for this kind of utility.
