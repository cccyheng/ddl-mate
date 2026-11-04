"""Offline PP-OCR line recognition. One bounded stdin request per process; no image files."""
import os
import sys

os.environ['ORT_DISABLE_TELEMETRY'] = '1'
sys.path.insert(0, sys.argv[1])

import base64
import io
import json
import math
import numpy as np
from PIL import Image
import onnxruntime as ort

ort.disable_telemetry_events()


def main():
    request = json.load(sys.stdin)
    lines = request['lines']
    if len(lines) > 1000:
        raise ValueError('Too many text lines')
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(sys.argv[2], sess_options=options, providers=['CPUExecutionProvider'])
    characters = ['blank'] + session.get_modelmeta().custom_metadata_map['character'].splitlines() + [' ']
    output = []
    for line in lines:
        with Image.open(io.BytesIO(base64.b64decode(line['png'], validate=True))) as source:
            image = source.convert('RGB')
        width, height = image.size
        resized_width = math.ceil(width / height * 48)
        if resized_width > 8192:
            output.append({'id': line['id'], 'text': '', 'confidence': 0})
            continue
        array = np.asarray(image.resize((resized_width, 48), Image.Resampling.BILINEAR), dtype=np.float32)
        array = array[:, :, ::-1].transpose(2, 0, 1) / 127.5 - 1
        padded = np.zeros((3, 48, max(320, resized_width)), dtype=np.float32)
        padded[:, :, :resized_width] = array
        predictions = session.run(None, {'x': padded[None]})[0][0]
        indices = predictions.argmax(axis=1)
        scores = predictions.max(axis=1)
        keep = (indices != 0) & np.r_[True, indices[1:] != indices[:-1]]
        text = ''.join(characters[index] for index in indices[keep])
        confidence = float(scores[keep].mean()) if keep.any() else 0
        output.append({'id': line['id'], 'text': text, 'confidence': confidence})
    sys.stdout.buffer.write(json.dumps({'lines': output}, ensure_ascii=False).encode('utf-8'))


if __name__ == '__main__':
    main()
