/**
 * Сжимает fon.png в WebP (макс. ширина 1920px, качество 82).
 * Запускается перед build:web. Исходник не трогает.
 * Если fon.png нет (например на сервере), но fon.webp есть — ничего не делаем (фон из репозитория).
 */
const path = require('path');
const fs = require('fs');

const assetsDir = path.join(__dirname, '..', 'src', 'web', 'ui', 'public', 'assets');
const inputPath = path.join(assetsDir, 'fon.png');
const outputPath = path.join(assetsDir, 'fon.webp');

if (!fs.existsSync(inputPath)) {
  if (fs.existsSync(outputPath)) {
    console.log('optimize-fon: fon.webp уже есть (из репозитория), пропуск');
  } else {
    console.log('optimize-fon: fon.png не найден, пропуск (нужен fon.webp в public/assets или локально запустите после добавления fon.png)');
  }
  process.exit(0);
}

const sharp = require('sharp');

sharp(inputPath)
  .resize(1920, null, { withoutEnlargement: true })
  .webp({ quality: 82 })
  .toFile(outputPath)
  .then((info) => {
    const sizeKB = (info.size / 1024).toFixed(1);
    console.log('optimize-fon: fon.webp создан,', sizeKB, 'KB');
  })
  .catch((err) => {
    console.error('optimize-fon:', err.message);
    process.exit(1);
  });
