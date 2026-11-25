#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
多产物构建（平台化地基 · 约束 3：产物清单驱动）

  python3 scripts/build.py            构建清单里的全部产物（开源版：参与者端 + 运营后台）
  python3 scripts/build.py meeting    只构建 meeting
  python3 scripts/build.py admin      只构建 admin
  python3 scripts/build.py --check    校验所有产物是否为最新（pre-commit 用）

产物清单 PRODUCTS 里加一条 = 多一个独立站点；脚本本身不用改。
每个产物 = HTML 骨架 + include 标记，JS 片段拼成单个 IIFE，CSS 走原有链路。
"""
import re, os, sys, hashlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FE = os.path.join(ROOT, 'frontend')
INCLUDE_HTML = re.compile(r'^\s*<!--@include:\s*(\S+?)\s*-->\s*$')
INCLUDE_JS = re.compile(r'^\s*/\*@include:\s*(\S+?)\s*\*/\s*$')

# ============ 产物清单：加端只加这里 ============
PRODUCTS = {
    'signin': {
        'html_shell': 'public/shell.html',
        'html_out': 'index.html',
        'js_shell': 'public/app.shell.js',
        'js_out': 'js/app.js',
        'desc': '参与者端 + 现场工作人员',
    },
    'admin': {
        'html_shell': 'admin/admin.html',
        'html_out': 'admin/index.html',
        'js_shell': 'admin/admin.shell.js',
        'js_out': 'admin/admin.js',
        'desc': '运营控制台',
    },
}


def render_file(shell_path, include_re):
    """与 build_html.py / build_js.py 的 render 保持一致：
    HTML 片段 rstrip 后作为一行插入；JS 片段按行展开。
    这里按 include 标记的类型分别处理，确保与旧脚本逐字节一致。"""
    if not os.path.exists(shell_path):
        sys.exit(f'缺少骨架: {shell_path}')
    is_js = (include_re is INCLUDE_JS)
    out = []
    for ln in open(shell_path, encoding='utf-8').read().split('\n'):
        m = include_re.match(ln)
        if m:
            frag = os.path.join(FE, m.group(1))
            if not os.path.exists(frag):
                sys.exit(f'片段缺失: {m.group(1)}')
            content = open(frag, encoding='utf-8').read()
            if is_js:
                out.extend(content.split('\n'))
            else:
                out.append(content.rstrip('\n'))
        else:
            out.append(ln)
    return '\n'.join(out)


def build_one(name, cfg):
    html = render_file(os.path.join(FE, cfg['html_shell']), INCLUDE_HTML)
    js = render_file(os.path.join(FE, cfg['js_shell']), INCLUDE_JS)
    hp = os.path.join(FE, cfg['html_out'])
    jp = os.path.join(FE, cfg['js_out'])
    os.makedirs(os.path.dirname(hp), exist_ok=True)
    os.makedirs(os.path.dirname(jp), exist_ok=True)
    open(hp, 'w', encoding='utf-8').write(html)
    open(jp, 'w', encoding='utf-8').write(js)
    print(f'  ✓ {name:<10} {cfg["desc"]:<20} HTML {len(html):>6} B · JS {len(js):>7} B')


def check_one(name, cfg):
    ok = True
    for key, inc in (('html_out', INCLUDE_HTML), ('js_out', INCLUDE_JS)):
        shell = 'html_shell' if key == 'html_out' else 'js_shell'
        want = render_file(os.path.join(FE, cfg[shell]), inc)
        got_path = os.path.join(FE, cfg[key])
        got = open(got_path, encoding='utf-8').read() if os.path.exists(got_path) else ''
        if want != got:
            print(f'  ✗ {name} 的 {cfg[key]} 已过期，请重新构建')
            ok = False
    return ok


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    check_mode = '--check' in sys.argv
    targets = args or list(PRODUCTS)
    unknown = [t for t in targets if t not in PRODUCTS]
    if unknown:
        sys.exit(f'未知产物: {unknown}；可选: {list(PRODUCTS)}')
    if check_mode:
        bad = [t for t in targets if not check_one(t, PRODUCTS[t])]
        print('✅ 全部产物为最新' if not bad else f'❌ 过期产物: {bad}')
        sys.exit(1 if bad else 0)
    print(f'构建 {len(targets)} 个产物：')
    for t in targets:
        build_one(t, PRODUCTS[t])
