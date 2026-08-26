"""把一张 4×N 的精灵表切成每套动画一条的横向条带。

**按人物对齐，不按标称网格。** 这是这个工具存在的全部理由。

画师给的表通常是 256×256 配 4 列，于是很容易以为格子就是 64px。实测不是：MIKU 那
套的人物中心在 35 / 96 / 155.5 / 217，而 64 网格该是 32 / 96 / 160 / 224。按标称网
格硬切，每列差两三像素，四列累积成 8px —— 表现为动画一边播一边往左漂，一轮漂完突
然跳回去。竖直方向同理，不同动画的脚线会差出十来个像素，切换动画时人物上下跳。

所以对齐锚在人物身上：

  横向 —— 取**下半身**（自身包围盒底部 40%）的重心。选下半身是因为它在这些动画里
          都不动：挥手抬的是手臂，欢呼举的是手，施法伸的是手，腿始终在原地。用整
          体重心会被抬起来的手臂拽偏。

  纵向 —— 取脚底（包围盒下沿），钉在同一行。人不会浮起来；同一角色的所有动画共用
          一条脚线，切换动画时才不会上下跳。

裁剪框严格按投影块的边界，**一点余量都不留**。块是把整张表按列/行投影出来的内容
精确范围，单格内容必然落在里面；而格与格之间往往只隔几个像素，多留 4px 就会把隔壁
人物的边缘吃进来，成品里表现为帧右侧一条竖杠。

输入支持两种：普通位图，以及"每像素一个 `<rect>`"的像素画 SVG（画师导出的常见形
式，这种 SVG 不需要栅格化，直接读就是精确像素）。

用法::

    python cut-sheet.py <表文件> <输出目录> <动画名,动画名,...> [--feet 60]
"""

from __future__ import annotations

import argparse
import re
import sys

from PIL import Image

CELL = 64

# 每像素一个 rect 的像素画 SVG。宽高会做游程压缩，所以要按矩形填。
RECT = re.compile(
    r'<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="#([0-9a-fA-F]{6})"\s*/>'
)


def load(path: str) -> Image.Image:
    """读一张表。

    :param path: 位图或像素画 SVG
    :returns: RGBA 图
    :raises ValueError: SVG 里一个可识别的 rect 都没有
    """
    if not path.lower().endswith('.svg'):
        return Image.open(path).convert('RGBA')

    text = open(path, encoding='utf-8').read()
    size = re.search(r'<svg[^>]*width="(\d+)"[^>]*height="(\d+)"', text)
    w, h = (int(size.group(1)), int(size.group(2))) if size else (256, 256)
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    px = img.load()
    count = 0
    for x, y, rw, rh, hexcolor in RECT.findall(text):
        x, y, rw, rh = int(x), int(y), int(rw), int(rh)
        rgb = (int(hexcolor[0:2], 16), int(hexcolor[2:4], 16), int(hexcolor[4:6], 16), 255)
        for yy in range(y, min(y + rh, h)):
            for xx in range(x, min(x + rw, w)):
                px[xx, yy] = rgb
        count += 1
    if count == 0:
        raise ValueError(f'{path}: 不是"每像素一个 rect"的像素画 SVG，认不出任何图元')
    # 没有 rect 覆盖到的地方 alpha 仍是 0 —— 透明是缺省，不是画出来的。
    return img


def blocks(counts: list[int]) -> list[tuple[int, int]]:
    """把一串"每行/列的不透明像素数"切成连续的非空块。"""
    out: list[tuple[int, int]] = []
    start = None
    for i, n in enumerate(counts):
        if n > 0 and start is None:
            start = i
        elif n == 0 and start is not None:
            out.append((start, i - 1))
            start = None
    if start is not None:
        out.append((start, len(counts) - 1))
    return out


def grid(img: Image.Image) -> tuple[list[tuple[int, int]], list[tuple[int, int]]]:
    """量出这张表真正用的列块与行块。

    :returns: (列块, 行块)
    """
    w, h = img.size
    a = img.split()[3].load()
    cols = [sum(1 for y in range(h) if a[x, y] > 40) for x in range(w)]
    rows = [sum(1 for x in range(w) if a[x, y] > 40) for y in range(h)]
    return blocks(cols), blocks(rows)


def anchor(img: Image.Image, box: tuple[int, int, int, int]):
    """算出一格里人物的锚点。

    :param img: 整张表
    :param box: 这一格的裁剪框
    :returns: (下半身重心 x, 脚底 y, 该格内容的包围盒)
    :raises ValueError: 格子是空的
    """
    sub = img.crop(box)
    bb = sub.getbbox()
    if bb is None:
        raise ValueError(f'空格子 {box}')
    x0, y0, x1, y1 = bb
    a = sub.split()[3].load()
    lower = y0 + int((y1 - y0) * 0.6)
    total = sx = 0
    for y in range(lower, y1):
        for x in range(x0, x1):
            if a[x, y] > 40:
                total += 1
                sx += x
    if total == 0:  # 下半身取不到内容（极扁的姿势），退回整体重心
        for y in range(y0, y1):
            for x in range(x0, x1):
                if a[x, y] > 40:
                    total += 1
                    sx += x
    return sx / total, y1, bb


def main() -> int:
    """入口。

    :returns: 进程退出码
    """
    ap = argparse.ArgumentParser(description='按人物对齐切分精灵表')
    ap.add_argument('sheet')
    ap.add_argument('outdir')
    ap.add_argument('anims', help='逗号分隔，每行一个，从上到下')
    ap.add_argument('--feet', type=int, default=60, help='脚底钉在第几行')
    ap.add_argument('--cols', type=int, default=4)
    args = ap.parse_args()

    anims = [a.strip() for a in args.anims.split(',') if a.strip()]
    img = load(args.sheet)
    cols, rows = grid(img)
    if len(cols) != args.cols or len(rows) != len(anims):
        print(f'量出来 {len(cols)} 列 × {len(rows)} 行，但要 {args.cols} × {len(anims)}', file=sys.stderr)
        print(f'  列块 {cols}', file=sys.stderr)
        print(f'  行块 {rows}', file=sys.stderr)
        return 1

    for r, anim in enumerate(anims):
        strip = Image.new('RGBA', (CELL * args.cols, CELL), (0, 0, 0, 0))
        sizes = []
        for c in range(args.cols):
            box = (cols[c][0], rows[r][0], cols[c][1] + 1, rows[r][1] + 1)
            cx, feet, bb = anchor(img, box)
            piece = img.crop(box).crop(bb)
            top = args.feet - (feet - bb[1])
            if top < 0:
                print(f'{anim} 第 {c + 1} 帧比 --feet 留出的空间还高', file=sys.stderr)
                return 1
            strip.paste(piece, (round(c * CELL + CELL / 2 - (cx - bb[0])), top), piece)
            sizes.append(f'{bb[2] - bb[0]}x{bb[3] - bb[1]}')
        out = f'{args.outdir}/{anim}.png'
        strip.save(out)
        print(f'  {anim:<24} {" ".join(sizes)}  → {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
