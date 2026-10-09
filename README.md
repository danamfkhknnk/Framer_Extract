# ExportNoCode

A tool that lets you export no‑code websites easily — starting with Framer.

## Features

- **Easy Downloads**: Download HTML files from supported no‑code sites by simply entering the URL
- **No Coding Required**: User-friendly interface for non-technical users
- **Fast Processing**: Quickly extract website files with a single click
- **Deploy Anywhere (Coming Soon)**: Deploy to any hosting provider with one-click deployment
- **Custom Domain Support (Coming Soon)**: Use your own domain for deployed mirrors
- **Analytics Integration (Coming Soon)**: Track visitor data on your deployed sites

## Getting Started

### Prerequisites

- Node.js 18.0 or higher
- pnpm, npm, or yarn
- Playwright Chromium browser (for extract / mirror)

### Installation

1. Clone the repository
```bash
git clone https://github.com/weknowyourgame/framer-deploy.git
cd framer-deploy
```

2. Install dependencies
```bash
pnpm install
```

3. Install Playwright browser (wajib sebelum extract/mirror)
```bash
npx playwright install chromium
# atau: pnpm exec playwright install chromium
```

4. (Opsional, hanya untuk API server / upload R2) buat file `.env.local`:
```bash
# SECRET_TOKEN=..., R2_ENDPOINT=..., R2_ACCESS_KEY=..., R2_SECRET_KEY=..., R2_BUCKET=...
# Lihat .env.local yang sudah ada sebagai contoh
```

5. Start the development server
```bash
pnpm dev # For Next.js frontend
pnpm api:dev # For Express API server
```

The Next.js application should now be running on `http://localhost:3000` and the Express API on `http://localhost:3001`.

## Playwright Extract (hasil ke root project)

Script `pnpm extract` menjalankan browser Chromium asli, membuka tiap halaman,
merekam semua response (HTML, JS, CSS, gambar, font), lalu me-rewrite `src` /
`srcset` / `href` jadi path lokal. Hasilnya ditaruh di **root project**:
`./<hostname>-export/`.

### Langkah-langkah extract

1. Pastikan setup selesai (install deps + `npx playwright install chromium` di atas).

2. Jalankan extract dengan URL target:
```bash
pnpm extract https://orange-property-949925.framer.app
```

3. Tunggu sampai muncul ringkasan `✔ Selesai` — contoh output:
```
✔ Selesai dalam 45.2s
  Halaman dikunjungi : 8
  Resource tersimpan : 120
  HTML di-rewrite    : 8
  Folder hasil       : /path/ke/project/orange-property-949925.framer.app-export
```

4. Lihat hasil (folder ada di root project):
```bash
ls ./orange-property-949925.framer.app-export
npx serve ./orange-property-949925.framer.app-export
# lalu buka http://localhost:3000
```

### Options extract

```bash
pnpm extract <url> [options]

--out <dir>         Folder output. Default: ./<hostname>-export/ di root project
--max-depth <n>     Kedalaman crawl link internal. Default: 2
                    (0 = hanya 1 halaman, 1 = + link langsung, dst.)
--timeout <ms>      Timeout per halaman. Default: 30000
--allowed <h1,h2>   Tambah host yang diizinkan, dipisah koma
-h, --help          Tampilkan bantuan
```

Contoh lain:
```bash
# Hanya 1 halaman, tanpa ikuti link
pnpm extract https://mysite.framer.website --max-depth 0

# Output ke folder custom di root
pnpm extract https://mysite.framer.website --out ./mysite-export

# Langsung via node
node scripts/extract.mjs https://mysite.framer.website --max-depth 1
```

### Catatan

- Folder `*-export/` otomatis di-ignore git (lihat `.gitignore`), jadi aman tidak ke-commit.
- Jika halaman lambat / blank, naikkan `--timeout` atau turunkan `--max-depth`.
- Script selalu menimpa folder output dari awal (fresh mirror).

## How to Use

1. Enter the URL of any supported website in the input field (e.g., mysite.framer.website)
2. Click the "Download" button
3. The application will process the website and provide downloadable HTML files
4. (Coming soon) Choose a hosting provider to deploy your website

## Tech Stack

- Next.js 15
- React 19
- Express.js (API server)
- TailwindCSS
- TypeScript

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.