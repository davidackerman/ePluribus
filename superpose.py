import numpy as np, skimage.data as d
from skimage.color import rgb2gray
from skimage.transform import resize
from skimage.metrics import structural_similarity as ssim
from scipy.optimize import nnls
rng=np.random.default_rng(0)
N=64
target=resize(rgb2gray(d.astronaut())[30:430,60:460],(N,N),anti_aliasing=True)

srcs={"hubble":rgb2gray(d.hubble_deep_field()),"moon":d.moon()/255.,"retina":rgb2gray(d.retina()),
      "microaneurysms":d.microaneurysms()/255.,"tissue":rgb2gray(d.immunohistochemistry())}
atoms,meta=[],[]
for name,img in srcs.items():
    H,W=img.shape
    for _ in range(1600 if min(H,W)>200 else 200):
        s=int(rng.integers(32,min(H,W)))
        y,x=rng.integers(0,H-s+1),rng.integers(0,W-s+1)
        a=resize(img[y:y+s,x:x+s],(N,N),anti_aliasing=True)
        a=np.rot90(a,rng.integers(4)); a=a[:, ::-1] if rng.random()<.5 else a
        atoms.append(a.ravel()); meta.append((name,int(y),int(x),s))
A=np.array(atoms).T  # pixels x atoms
print("dictionary:",A.shape[1],"real image crops from",list(srcs))

t=target.ravel()
def score(rec):
    r=np.corrcoef(rec,t)[0,1]
    lo,hi=t.min(),t.max()
    rr=(rec-rec.mean())/rec.std()*t.std()+t.mean()
    return r, ssim(rr.reshape(N,N),target,data_range=hi-lo), rr

def omp(D,y,k):
    Dn=D/np.linalg.norm(D,axis=0); res=y.copy(); S=[]
    for _ in range(k):
        S.append(int(np.argmax(np.abs(Dn.T@res))))
        w,*_=np.linalg.lstsq(D[:,S],y,rcond=None); res=y-D[:,S]@w
    return D[:,S]@w,S,w

def nnmp(D,y,k):  # additive only: non-negative weights, like stacking transparencies
    Dn=D/np.linalg.norm(D,axis=0); res=y.copy(); S=[]
    for _ in range(k):
        c=Dn.T@res; c[S]=-np.inf; S.append(int(np.argmax(c)))
        w,_=nnls(D[:,S],y); res=y-D[:,S]@w
    return D[:,S]@w,S,w

# signed: work on mean-removed atoms and target
Ac=A-A.mean(0); tc=t-t.mean()
results=[]
for k in (10,30,100,300):
    rec,S,w=omp(Ac,tc,k); r,s,img=score(rec); results.append((f"signed, {k} images",img,r,s,S,w))
for k in (30,100,300):
    rec,S,w=nnmp(A,t,k); r,s,img=score(rec); results.append((f"add-only, {k} images",img,r,s,S,w))
# thresholded building blocks (each crop binarized at its median)
B=(A>np.median(A,0)).astype(float); keep=B.std(0)>0.1; B=B[:,keep]; Bc=B-B.mean(0)
rec,S,w=omp(Bc,tc,100); r,s,img=score(rec); results.append(("signed, 100 thresholded",img,r,s,S,w))
# baseline: same number of random-ish smooth basis (DCT low freq) for reference
from scipy.fft import idctn
dct=[]
for u in range(N):
    for v in range(N):
        if u+v<15 and (u,v)!=(0,0):
            c=np.zeros((N,N)); c[u,v]=1; dct.append(idctn(c,norm="ortho").ravel())
Dd=np.array(dct).T[:, :100]
rec,S,w=omp(Dd,tc,100); r,s,img=score(rec); results.append(("100 cosine waves",img,r,s,S,w))
for name,img,r,s,S,w in results: print(f"{name:28s} corr={r:.3f} ssim={s:.3f}")

import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
fig,ax=plt.subplots(2,5,figsize=(15,6.4))
ax.flat[0].imshow(target,cmap="gray"); ax.flat[0].set_title("target")
for a_,(name,img,r,s,S,w) in zip(ax.flat[1:],results):
    a_.imshow(np.clip(img.reshape(N,N),0,1),cmap="gray"); a_.set_title(f"{name}\ncorr {r:.2f}, SSIM {s:.2f}",fontsize=9)
for a_ in ax.flat: a_.axis("off")
plt.tight_layout(); plt.savefig("superpose.png",dpi=90)
# which images got used most strongly in the 100-image signed version
name,img,r,s,S,w=results[2]
order=np.argsort(-np.abs(w))[:8]
fig,ax=plt.subplots(1,8,figsize=(16,2.4))
for a_,i in zip(ax,order):
    a_.imshow(A[:,S[i]].reshape(N,N),cmap="gray"); a_.set_title(f"{meta[S[i]][0]} w={w[i]:+.2f}",fontsize=8); a_.axis("off")
plt.tight_layout(); plt.savefig("superpose_atoms.png",dpi=90)
from collections import Counter
print("sources used (signed, 100):",Counter(meta[i][0] for i in S))
