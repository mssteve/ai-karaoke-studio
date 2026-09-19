import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'build', 'icon.svg')
const output = path.join(root, 'build')
const sizes = [16, 24, 32, 48, 64, 128, 256]

await mkdir(output, { recursive: true })
const pngPaths = await Promise.all(sizes.map(async (size) => {
  const target = path.join(output, `icon-${size}.png`)
  await sharp(source).resize(size, size).png().toFile(target)
  return target
}))

await sharp(source).resize(512, 512).png().toFile(path.join(output, 'icon.png'))
await writeFile(path.join(output, 'icon.ico'), await pngToIco(pngPaths))
