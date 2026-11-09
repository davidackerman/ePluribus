import numpy as np, skimage.data as d, time, pickle
from skimage.color import rgb2gray
from skimage.transform import resize
from scipy.optimize import nnls
t0=time.time(); rng=np.random.default_rng(0); N=64
target=resize(rgb2gray(d.astronaut())[30:430,60:460],(N,N),anti_aliasing=True); t=target.ravel()
srcs={"hubble":rgb2gray(d.hubble_deep_field()),"moon":d.moon()/255.,"retina":rgb2gray(d.retina()),
      "tissue":rgb2gray(d.immunohistochemistry())}
small={k:resize(v,(256,256),anti_aliasing=True) for k,v in srcs.items()}
names=list(small); atoms,meta=[],[]
for i in range(12000):
    nm=names[rng.integers(len(names))]; img=small[nm]
    s=int(rng.integers(16,200)); y,x=rng.integers(0,256-s+1,2)
    m=int(rng.choice([6,8,12,16,24,32,40]))
    a=resize(img[y:y+s,x:x+s],(m,m),anti_aliasing=False,order=1); a=np.rot90(a,rng.integers(4))
    yy,xx=np.mgrid[:m,:m]; win=np.exp(-(((yy-(m-1)/2)**2+(xx-(m-1)/2)**2)/(2*(m/3.2)**2)))
    c=np.zeros((N+2*m,N+2*m)); py,px=rng.integers(0,N+m,2); c[py:py+m,px:px+m]=a*win; c=c[m:m+N,m:m+N]
    if c.std()>1e-3: atoms.append(c.ravel()); meta.append((nm,m))
P=np.array(atoms).T; Pn=P/np.linalg.norm(P,axis=0)
res=t.copy(); S=[]; snaps={}; K=300
keep={1,2,3,4,5,6,8,10,12,15,18,22,26,30,36,42,50,60,70,85,100,120,140,165,190,220,250,280,300}
for k in range(1,K+1):
    c=Pn.T@res; c[S]=-np.inf; S.append(int(np.argmax(c)))
    w,_=nnls(P[:,S],t); res=t-P[:,S]@w
    if k in keep: snaps[k]=(P[:,S]@w).reshape(N,N)
print(f"pursuit done {time.time()-t0:.0f}s")
pickle.dump(dict(target=target,snaps=snaps,S=S,w=w,P=P[:,S],meta=[meta[i] for i in S]),open("anim_state.pkl","wb"))
