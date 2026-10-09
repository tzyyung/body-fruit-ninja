#!/usr/bin/env python3
"""把 TFJS graph-model 的權重再量化成 uint8。

為什麼要自己寫：官方的 tensorflowjs_converter 只支援 tfjs_layers_model
的再量化，而 MoveNet 是 graph-model；而且它會拉進 TensorFlow + JAX 幾 GB
的相依。這裡要做的事其實只是「換一種存法」，不需要那整套。

反量化的算式取自 tfjs-core 的 decodeWeight()：
    values[i] = q[i] * quantization.scale + quantization.min
所以量化就是反過來：
    scale = (max - min) / 255
    q     = round((v - min) / scale)
"""
import json
import sys
from pathlib import Path

import numpy as np

SHARD_BYTES = 4 * 1024 * 1024
# 一階量化步距超過「典型權重量級」的這個倍數就不量化，原樣保留 float16。
#
# 掃出來的（對 movenet-lightning，誤差＝典型權重被改動的中位比例）：
#   門檻   體積        佔原模型  跳過  最糟張量   >10% 的張量
#   2.0    2,503,353     52%      2     45.0%        8
#   1.0    2,517,334     52%      5     20.3%        5
#   0.5    2,533,078     53%      9     12.2%        1
#   0.3    2,597,892     54%     12      7.0%        0   ← 選這個
#   0.2    2,611,572     54%     17      5.1%        0
#
# 1.0 → 0.3 只多 80KB（52% → 54%），但最糟誤差從 20.3% 掉到 7.0%，
# 而且沒有任何張量超過 10%。省那 80KB 不值得冒毀掉一層的風險。
KEEP_IF_STEP_OVER = 0.3
RAW_BYTES = {'float32': 4, 'int32': 4, 'bool': 1, 'uint8': 1,
             'uint16': 2, 'float16': 2, 'complex64': 8}


def numel(shape):
    n = 1
    for d in shape:
        n *= d
    return n


def decode(spec, buf):
    """把一段位元組還原成 numpy 陣列，以及它實際佔了幾個位元組。"""
    n = numel(spec['shape'])
    q = spec.get('quantization')
    store = q['dtype'] if q else spec['dtype']
    nbytes = n * RAW_BYTES[store]
    raw = buf[:nbytes]
    if q and store == 'float16':
        return np.frombuffer(raw, dtype=np.float16).astype(np.float32), nbytes
    if q and store in ('uint8', 'uint16'):
        dt = np.uint8 if store == 'uint8' else np.uint16
        vals = np.frombuffer(raw, dtype=dt).astype(np.float32)
        return vals * q['scale'] + q['min'], nbytes
    return np.frombuffer(raw, dtype=np.dtype(spec['dtype'])), nbytes


def requantize(src_dir: Path, dst_dir: Path):
    model = json.loads((src_dir / 'model.json').read_text())
    dst_dir.mkdir(parents=True, exist_ok=True)

    out_bytes = bytearray()
    new_manifest = []
    worst = []          # (步距/典型量級, 名稱)
    skipped = []        # 動態範圍太大、原樣保留的
    kept, converted = 0, 0

    for group in model['weightsManifest']:
        blob = b''.join((src_dir / p).read_bytes() for p in group['paths'])
        off = 0
        new_specs = []
        for spec in group['weights']:
            vals, used = decode(spec, blob[off:])
            off += used
            new = {'name': spec['name'], 'shape': spec['shape'], 'dtype': spec['dtype']}

            if spec['dtype'] != 'float32':
                # int32 之類的直接原樣帶過去，量化它們沒有意義
                out_bytes += vals.tobytes()
                kept += 1
                new_specs.append(new)
                continue

            lo = float(vals.min()) if vals.size else 0.0
            hi = float(vals.max()) if vals.size else 0.0

            # 整張量統一量化，碰到動態範圍很大的張量就會把小權重全部碾平。
            # 判準：一階量化步距有沒有大過「典型權重的量級」。
            #
            # MobileNetV2 的 depthwise 權重正是這一族（逐通道的尺度差很多），
            # 實測 5 個張量的步距是典型權重的 1.5–5.8 倍 —— 那幾層等於被毀掉。
            # 2026-10-09 真機量到的後果：uint8 在 29 幀裡**一次都沒偵測到人**，
            # 同樣那 29 幀 fp16 只漏 1 次。
            #
            # 這 5 個只佔全部權重的 0.74%（17,136 個元素），原樣保留只多 17KB。
            # 正解是 per-channel 量化（TFLite 對 depthwise 就是這樣做），
            # 但那要改 tfjs 的反量化路徑；這裡用「跳過」換 0.7% 的體積。
            nz = np.abs(vals) > 0
            typical = float(np.median(np.abs(vals[nz]))) if nz.any() else 0.0
            step = (hi - lo) / 255.0
            if typical > 0 and step > typical * KEEP_IF_STEP_OVER:
                out_bytes += vals.astype(np.float16).tobytes()
                new['quantization'] = {'dtype': 'float16', 'original_dtype': 'float32'}
                skipped.append((step / typical, spec['name']))
                new_specs.append(new)
                continue

            if hi == lo:
                # 常數張量：scale 給 1，全部存 0，還原時 0*1+min = min
                scale = 1.0
                q = np.zeros(vals.shape, dtype=np.uint8)
            else:
                scale = (hi - lo) / 255.0
                q = np.clip(np.rint((vals - lo) / scale), 0, 255).astype(np.uint8)

            # 不要報「誤差佔值域的比例」—— 那永遠是半個量化階（0.196%），
            # 不管模型有沒有壞都一樣，等於量了一個不會變的數字。
            # 要報的是「一階步距相對於典型權重有多大」。
            if typical > 0:
                worst.append((step / typical, spec['name']))

            out_bytes += q.tobytes()
            new['quantization'] = {'dtype': 'uint8', 'original_dtype': 'float32',
                                   'scale': scale, 'min': lo}
            converted += 1
            new_specs.append(new)

        # 切成跟原本同樣大小的分片
        total = len(out_bytes)
        n_shards = max(1, -(-total // SHARD_BYTES))
        paths = []
        for i in range(n_shards):
            name = f'group1-shard{i + 1}of{n_shards}.bin'
            (dst_dir / name).write_bytes(bytes(out_bytes[i * SHARD_BYTES:(i + 1) * SHARD_BYTES]))
            paths.append(name)
        new_manifest.append({'paths': paths, 'weights': new_specs})
        out_bytes = bytearray()

    model['weightsManifest'] = new_manifest
    (dst_dir / 'model.json').write_text(json.dumps(model))

    src_sz = sum(f.stat().st_size for f in src_dir.iterdir() if f.is_file())
    dst_sz = sum(f.stat().st_size for f in dst_dir.iterdir() if f.is_file())
    worst.sort(reverse=True)
    skipped.sort(reverse=True)
    print(f'  張量 {converted} 個轉成 uint8、{kept} 個非 float32 原樣保留、'
          f'{len(skipped)} 個動態範圍太大保留 float16')
    print(f'  {src_sz:,} → {dst_sz:,} bytes  ({100 * dst_sz / src_sz:.0f}%)')
    print(f'  量化步距 / 典型權重量級（> 1 就是把小權重碾平，必須跳過）')
    if worst:
        print(f'    有量化的裡面最大 {worst[0][0]:.2f}   中位 '
              f'{worst[len(worst) // 2][0]:.2f}')
        print(f'    最大的那個：{worst[0][1][-60:]}')
    for r, n in skipped:
        print(f'    跳過 {r:5.2f}  {n[-60:]}')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(f'用法：{sys.argv[0]} <來源目錄> <輸出目錄>')
        sys.exit(1)
    requantize(Path(sys.argv[1]), Path(sys.argv[2]))
