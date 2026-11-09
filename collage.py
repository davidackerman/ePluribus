import numpy as np, skimage.data as d, time
from skimage.color import rgb2gray
from skimage.transform import resize, rescale
from skimage.metrics import structural_similarity as ssim
from scipy.optimize import nnls
t0=time.time(); rng=np.random.default_rng(0); N=64
target=resize(rgb2gray(d.astronaut())[30:430,60:460],(N,N),anti_aliasing=True); t=target.ravel()
srcs={"hubble":rgb2gray(d.hubble_deep_field()),"moon":d.moon()/255.,"retina":rgb2gray(d.retina()),
      "tissue":rgb2gray(d.immunohistochemistry())}
small={k:resize(v,(256,256),anti_aliasing=True) for k,v in srcs.items()}  # pre-shrink so crops are cheap
names=list(small); atoms=[]
for i in range(12000):
    img=small[names[rng.integers(len(names))]]
    s=int(rng.integers(16,200)); y,x=rng.integers(0,256-s+1,2)
    m=int(rng.choice([6,8,12,16,24,32,40]))
    a=resize(img[y:y+s,x:x+s],(m,m),anti_aliasing=False,order=1); a=np.rot90(a,rng.integers(4))
    yy,xx=np.mgrid[:m,:m]; win=np.exp(-(((yy-(m-1)/2)**2+(xx-(m-1)/2)**2)/(2*(m/3.2)**2)))
    c=np.zeros((N+2*m,N+2*m)); py,px=rng.integers(0,N+m,2); c[py:py+m,px:px+m]=a*win
    c=c[m:m+N,m:m+N]
    if c.std()>1e-3: atoms.append(c.ravel())
P=np.array(atoms).T.astype(np.float32); print("atoms",P.shape[1],f"{time.time()-t0:.0f}s")
Pn=P/np.linalg.norm(P,axis=0)
def pursuit(D,Dn,y,k,nonneg):
    res=y.copy(); S=[]
    for _ in range(k):
        c=Dn.T@res
        if nonneg: c[S]=-np.inf; S.append(int(np.argmax(c))); w,_=nnls(D[:,S].astype(float),y)
        else: S.append(int(np.argmax(np.abs(c)))); w,*_=np.linalg.lstsq(D[:,S],y,rcond=None)
        res=y-D[:,S]@w
    return D[:,S]@w
def score(rec):
    rr=(rec-rec.mean())/rec.std()*t.std()+t.mean()
    return np.corrcoef(rec,t)[0,1], ssim(rr.reshape(N,N),target,data_range=t.max()-t.min()), rr
out=[]
for k,nn in ((100,True),(300,True),(100,False),(300,False)):
    rec=pursuit(P,Pn,(t if nn else t-t.mean()).astype(np.float32),k,nn); r,s,img=score(rec)
    out.append((f"{'add-only' if nn else 'signed'} collage, {k}",img,r,s)); print(out[-1][0],f"corr={r:.3f} ssim={s:.3f}",f"{time.time()-t0:.0f}s",flush=True)
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
fig,ax=plt.subplots(1,5,figsize=(15,3.4))
ax[0].imshow(target,cmap="gray"); ax[0].set_title("target")
for a_,(n,img,r,s) in zip(ax[1:],out):
    a_.imshow(np.clip(img.reshape(N,N),0,1),cmap="gray"); a_.set_title(f"{n}\ncorr {r:.2f}, SSIM {s:.2f}",fontsize=9)
for a_ in ax: a_.axis("off")
plt.tight_layout(); plt.savefig("collage.png",dpi=90)
