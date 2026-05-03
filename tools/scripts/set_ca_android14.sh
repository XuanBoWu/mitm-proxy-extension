#!/system/bin/sh

# 设置错误处理：任何命令失败时退出脚本
set -e

# 创建临时目录
echo "创建临时目录 /data/local/tmp/tmp-ca-copy..."
mkdir -p -m 700 /data/local/tmp/tmp-ca-copy || {
    echo "创建临时目录失败"
    exit 1
}

# 复制现有证书到临时目录
echo "复制现有证书到临时目录..."
cp /apex/com.android.conscrypt/cacerts/* /data/local/tmp/tmp-ca-copy/ || {
    echo "复制证书失败"
    exit 2
}

# 在系统证书目录上创建内存挂载
echo "在 /system/etc/security/cacerts 上创建内存挂载..."
mount -t tmpfs tmpfs /system/etc/security/cacerts || {
    echo "挂载 tmpfs 失败"
    exit 3
}

# 将现有证书复制回 tmpfs
echo "将现有证书复制回 tmpfs..."
mv /data/local/tmp/tmp-ca-copy/* /system/etc/security/cacerts/ || {
    echo "移动证书失败"
    exit 4
}

# 复制新证书到 tmpfs
echo "复制新证书到 tmpfs..."
cp /data/local/tmp/*.0 /system/etc/security/cacerts/ || {
    echo "复制新证书失败"
    exit 5
}

# 更新权限和 SELinux 上下文
echo "更新权限和 SELinux 上下文..."
chown root:root /system/etc/security/cacerts/* || {
    echo "更新所有者失败"
    exit 6
}
chmod 644 /system/etc/security/cacerts/* || {
    echo "更新权限失败"
    exit 7
}
chcon u:object_r:system_file:s0 /system/etc/security/cacerts/* || {
    echo "更新 SELinux 上下文失败"
    exit 8
}

# 处理 APEX 覆盖
echo "处理 APEX 覆盖..."

# 获取 Zygote 进程的 PID
ZYGOTE_PID=$(pidof zygote || true)
ZYGOTE64_PID=$(pidof zygote64 || true)

# 将挂载注入到每个 Zygote 命名空间
for Z_PID in "$ZYGOTE_PID" "$ZYGOTE64_PID"; do
    if [ -n "$Z_PID" ]; then
        echo "将挂载注入到 Zygote 进程 $Z_PID..."
        nsenter --mount=/proc/$Z_PID/ns/mnt -- \
            mount --bind /system/etc/security/cacerts /apex/com.android.conscrypt/cacerts || {
            echo "注入 Zygote 挂载失败"
            exit 9
        }
        echo "nsenter Z_PID: $Z_PID"
    fi
done

# 获取所有由 Zygote 启动的应用程序的 PID
APP_PIDS=$(
    for Z_PID in $ZYGOTE_PID $ZYGOTE64_PID; do
        ps -P "$Z_PID" -o PID | tail -n +2
    done
)

# 将挂载注入到每个应用程序的命名空间
echo "将挂载注入到所有应用程序..."
for PID in $APP_PIDS; do
    nsenter --mount=/proc/$PID/ns/mnt -- \
        mount --bind /system/etc/security/cacerts /apex/com.android.conscrypt/cacerts || {
        echo "注入应用程序挂载失败"
        exit 11
    }
    echo "nsenter PID: $PID"
done

echo "系统证书注入完成"