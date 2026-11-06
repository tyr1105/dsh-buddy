# -*- coding: utf-8 -*-
"""
asar_extract.py —— 从 DSH 桌面版安装包里，只读地解出官方插件源码，方便查证研究底稿里的证据。

【为什么需要它】
DSH（DeepSeek Harness）是 Electron 应用，官方的 300 多个插件包都打包在
"/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" 这一个文件里。
asar 是 Electron 自己的打包格式，类似一个不压缩的 zip。研究底稿（docs/evidence/）里
写的证据路径形如 dsh-src/@deepseek-ai/dsh-schedule/lib/index.js，指的就是用本脚本
解出来的目录。DSH 升级后接口可能变化，需要重新解包、重新核对。

【它不会做什么】
- 不修改安装包，只读取；
- 不读取 ~/.dsh 下的任何凭据或配置；
- 不联网。

【用法】（在终端运行一条命令即可，路径按需替换）
    python3 tools/asar_extract.py dsh/node_modules/@deepseek-ai 输出目录
第一个参数是安装包内部的路径前缀，只解出这个前缀下面的文件；
第二个参数是解到哪里，建议放在临时目录，体积约 250MB。
"""

import json      # 解析 asar 文件头里的 JSON 目录表
import os        # 拼路径、建目录
import struct    # 把文件开头的二进制字节解读成整数
import sys       # 读取命令行参数

# DSH 安装包的默认位置；如果装在别处，可以用环境变量 DSH_ASAR 覆盖
ASAR_PATH = os.environ.get(
    "DSH_ASAR", "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"
)


def read_header(asar_path):
    """读取 asar 文件开头的「目录表」。

    asar 的结构是：开头 16 个字节记录几个长度，紧接着是一段 JSON，
    JSON 里像文件夹树一样列出每个文件的位置（offset）和大小（size）；
    JSON 之后才是所有文件内容首尾相接的数据区。
    返回值：(目录表字典, 数据区在整个文件里的起始位置)
    """
    with open(asar_path, "rb") as f:
        f.read(4)                                        # 第 1 个 4 字节：固定为 4，跳过
        header_size = struct.unpack("<I", f.read(4))[0]  # 第 2 个 4 字节：头部总长度
        f.read(4)                                        # 第 3 个 4 字节：内层长度，用不到
        json_len = struct.unpack("<I", f.read(4))[0]     # 第 4 个 4 字节：JSON 文本的真实长度
        header = json.loads(f.read(json_len).decode("utf-8"))
    # 数据区紧跟在头部之后：8 个字节的长度信息 + 头部本身
    return header, 8 + header_size


def extract(prefix, out_dir, asar_path=ASAR_PATH):
    """把安装包里 prefix 开头的所有文件，原样写到 out_dir 下面。"""
    prefix = prefix.rstrip("/")
    header, data_start = read_header(asar_path)
    # 少数需要原生加载的文件不在 asar 里，而是放在旁边的 app.asar.unpacked 目录
    unpacked_root = asar_path + ".unpacked"
    count, total = 0, 0

    def walk(node, path):
        nonlocal count, total
        for name, child in node.get("files", {}).items():
            full = f"{path}/{name}" if path else name
            # 只往和前缀相关的分支里走：要么当前路径在前缀之下，要么前缀在当前路径之下
            if not (full.startswith(prefix) or prefix.startswith(full)):
                continue
            if "files" in child:          # 有 files 键说明这是一个文件夹，继续往下
                walk(child, full)
                continue
            if not full.startswith(prefix):
                continue
            if "link" in child:           # 符号链接没有实际内容，跳过
                continue
            # 计算输出位置：去掉前缀，剩下的相对路径照搬；前缀本身就是单个文件时用文件名
            rel = full[len(prefix):].lstrip("/") or os.path.basename(full)
            dest = os.path.join(out_dir, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if child.get("unpacked"):
                # 标记为 unpacked 的文件，直接从旁边的目录复制
                src = os.path.join(unpacked_root, full)
                if not os.path.exists(src):
                    continue
                with open(src, "rb") as s:
                    data = s.read()
            else:
                # 普通文件：按目录表给的位置和大小，从数据区里切出来
                with open(asar_path, "rb") as s:
                    s.seek(data_start + int(child["offset"]))
                    data = s.read(child["size"])
            with open(dest, "wb") as d:
                d.write(data)
            count += 1
            total += len(data)

    walk(header, "")
    print(f"解出 {count} 个文件，共 {total / 1e6:.1f} MB → {out_dir}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("用法：python3 tools/asar_extract.py <安装包内路径前缀> <输出目录>")
        print("例如：python3 tools/asar_extract.py dsh/node_modules/@deepseek-ai /tmp/dsh-src/@deepseek-ai")
        sys.exit(1)
    extract(sys.argv[1], sys.argv[2])
