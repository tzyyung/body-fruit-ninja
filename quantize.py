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
    worst = []          # (相對誤差, 名稱)
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
            if hi == lo:
                # 常數張量：scale 給 1，全部存 0，還原時 0*1+min = min
                scale = 1.0
                q = np.zeros(vals.shape, dtype=np.uint8)
            else:
                scale = (hi - lo) / 255.0
                q = np.clip(np.rint((vals - lo) / scale), 0, 255).astype(np.uint8)

            back = q.astype(np.float32) * scale + lo
            span = hi - lo
            if span > 0:
                worst.append((float(np.abs(back - vals).max() / span), spec['name']))

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
    print(f'  張量 {converted} 個轉成 uint8、{kept} 個原樣保留')
    print(f'  {src_sz:,} → {dst_sz:,} bytes  ({100 * dst_sz / src_sz:.0f}%)')
    print(f'  量化誤差（佔該張量值域的比例）')
    print(f'    最大 {worst[0][0] * 100:.3f}%   中位 '
          f'{worst[len(worst) // 2][0] * 100:.3f}%')
    print(f'    最差的張量：{worst[0][1][:70]}')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(f'用法：{sys.argv[0]} <來源目錄> <輸出目錄>')
        sys.exit(1)
    requantize(Path(sys.argv[1]), Path(sys.argv[2]))
