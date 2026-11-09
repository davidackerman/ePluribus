import numpy as np, pickle
from PIL import Image, ImageDraw, ImageFont
import matplotlib; matplotlib.use("Agg"); import matplotlib.cm as cm
st=pickle.load(open("anim_state.pkl","rb"))
N=64; S=168; W,H=600,380; BG=np.array([14,16,22],float)
final=st["snaps"][300]; vmax=np.percentile(final,99.5)
sizes=sorted({m for _,m in st["meta"]},reverse=True)            # coarse -> fine, like low -> high frequency
layers=[]
for m in sizes:
    idx=[i for i,(_,mm) in enumerate(st["meta"]) if mm==m]
    layers.append((st["P"][:,idx]@st["w"][idx]).reshape(N,N))
L=len(layers); lnorm=[np.percentile(l,99.5)+1e-9 for l in layers]; energy=np.array([np.linalg.norm(l) for l in layers]); energy/=energy.max()
cols=[np.array(cm.plasma(0.15+0.75*j/(L-1))[:3])*255 for j in range(L)]
try: font=ImageFont.load_default(size=15); small=ImageFont.load_default(size=12)
except TypeError: font=small=ImageFont.load_default()

def up(a): return np.kron(a,np.ones((S//N,S//N)))
def gray_rgba(a,alpha_gain=None,color=None,border=False,norm=None):
    g=np.clip(up(a)/(vmax if norm is None else norm),0,1)
    tint=np.array([255.,255.,255.]) if color is None else 0.45*255+0.55*color
    rgb=g[...,None]*tint
    alpha=np.full(g.shape,255.) if alpha_gain is None else np.clip(g*alpha_gain,0,1)*255
    if border:
        for sl in (np.s_[:2,:],np.s_[-2:,:],np.s_[:,:2],np.s_[:,-2:]): alpha[sl]=110; rgb[sl]=170
    return Image.fromarray(np.dstack([rgb,alpha[...,None]]).astype(np.uint8))

def base(): return Image.new("RGBA",(W,H),tuple(int(x) for x in BG)+(255,))
def place(canvas,img,cx,cy,s):     # tilt the plane by s in [0,1] (squash + shear) and centre it at (cx,cy)
    a=1-0.45*s; b=-0.22*s
    data=(1/a,0,S/2-cx/a,-(b/a),1,S/2-cy+(b/a)*cx)
    canvas.alpha_composite(img.transform((W,H),Image.AFFINE,data,resample=Image.BILINEAR))

frames,durs=[],[]
def add(im,ms): frames.append(im.convert("RGB")); durs.append(ms)
def caption(im,text,y=H-30):
    ImageDraw.Draw(im).text((W//2,y),text,fill=(220,220,230),font=font,anchor="mm")

# A: build-up
snaps=st["snaps"]
for k in sorted(snaps):
    im=base(); place(im,gray_rgba(snaps[k]),W//2,H//2-12,0)
    tgt=gray_rgba(st["target"]*vmax/np.percentile(st["target"],99.5)).resize((64,64))
    im.alpha_composite(tgt,(W-80,14)); ImageDraw.Draw(im).text((W-48,86),"target",fill=(150,150,160),font=small,anchor="mm")
    caption(im,f"{k} pieces of Hubble, Moon, retina and tissue images, added as light"); add(im,140 if k<60 else 90)
for _ in range(1): add(frames[-1],1400)

# B: explode into size layers (coarse at front-left, fine at back-right), then show the "spectrum"
def exploded(s,bars=0.0,label=True):
    im=base()
    cx0,cy0=W//2,H//2-22; dx,dy=44,-12
    if s<0.999:   # cross-fade from the summed picture
        merged=base(); place(merged,gray_rgba(final),cx0,cy0,s)
        im=Image.blend(im,merged,1-s)
    for j in reversed(range(L)):
        off=(j-(L-1)/2)
        place(im,gray_rgba(layers[j],alpha_gain=1.6*s,color=cols[j],border=s>0.05,norm=lnorm[j]),
              int(cx0+s*off*dx), int(cy0+s*off*dy), s)
    dr=ImageDraw.Draw(im)
    if bars>0:
        x0,bw=W//2-L*22//2,18
        for j in range(L):
            h=int(70*energy[j]*bars); x=x0+j*22
            dr.rectangle([x,H-58-h,x+bw,H-58],fill=tuple(int(c) for c in cols[j]))
            dr.text((x+bw//2,H-48),f"{sizes[j]}",fill=(170,170,180),font=small,anchor="mm")
        dr.text((x0-8,H-52),"piece size (px):",fill=(170,170,180),font=small,anchor="rm")
    if label: caption(im,"the same picture, sliced by piece size: big = broad shading, small = fine detail" if s>0.5 else "")
    return im
ease=lambda u:0.5-0.5*np.cos(np.pi*u)
for u in np.linspace(0,1,26): add(exploded(ease(u)),60)
for u in np.linspace(0,1,12): add(exploded(1,bars=ease(u)),70)
add(exploded(1,bars=1),2200)
for u in np.linspace(1,0,22): add(exploded(ease(u),bars=0,label=False),60)
im=base(); place(im,gray_rgba(final),W//2,H//2-12,0); caption(im,"300 pieces, summed"); add(im,1600)

frames[0].save("science_collage_build_and_slice.gif",save_all=True,append_images=frames[1:],
               duration=durs,loop=0,optimize=True)
import os; print(len(frames),"frames", os.path.getsize("science_collage_build_and_slice.gif")//1024,"KB")
# stills for checking
frames[len(snaps)-1].save("chk_build.png"); frames[len(snaps)+38].save("chk_slice.png"); frames[len(snaps)+12].save("chk_mid.png")
