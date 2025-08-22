#!/bin/bash

# cos 配置文件
SOURCE_DIR="./ssm/config/${target}"
DEST_DIR="./dist/ssm"

rm -rf "$DEST_DIR"
cp -r "$SOURCE_DIR" "$DEST_DIR"
