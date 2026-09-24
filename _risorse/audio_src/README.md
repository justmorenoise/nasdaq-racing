Sorgenti dei loop del motore (non versionate). Per rigenerare `public/audio/`:

```
curl -L -o fw32.ogg "https://upload.wikimedia.org/wikipedia/commons/f/f5/Williams-Cosworth_FW32_%282010%29.ogg"
curl -L -o f60.ogg "https://upload.wikimedia.org/wikipedia/commons/a/aa/Ferrari_F60_%282009%29.ogg"
curl -L -o tyres.wav "https://opengameart.org/sites/default/files/tires_squal_loop.wav"
for f in fw32 f60; do ffmpeg -y -i $f.ogg -ac 1 -ar 44100 $f.wav; done
python3 make_engine.py
ffmpeg -y -i tyres.wav -ac 1 -ar 44100 -sample_fmt s16 ../../public/audio/tyres.wav
```

Licenze e autori: `public/audio/CREDITS.md`.
