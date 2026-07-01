import re, numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection
def load(fn): return np.array(re.findall(r'vertex\s+(\S+)\s+(\S+)\s+(\S+)',open(fn).read()),float).reshape(-1,3,3)
def shade(T,base):
    n=np.cross(T[:,1]-T[:,0],T[:,2]-T[:,0]);nl=np.linalg.norm(n,axis=1,keepdims=True);nl[nl==0]=1;n=n/nl
    L=np.array([0.5,0.4,0.65]);L=L/np.linalg.norm(L);s=0.5+0.5*np.clip(np.abs(n@L),0,1)
    return np.clip(base[None,:]*s[:,None],0,1)
def draw(ax,fn,t,el,az,col):
    T=load(fn);pc=Poly3DCollection(T,facecolor=shade(T,np.array(col)),edgecolor=(0.15,0.12,0.1,0.4),linewidths=0.2);pc.set_zsort('max');ax.add_collection3d(pc)
    v=T.reshape(-1,3);lo=v.min(0);hi=v.max(0);c=(lo+hi)/2;r=(hi-lo).max()/2*1.04
    ax.set_xlim(c[0]-r,c[0]+r);ax.set_ylim(c[1]-r,c[1]+r);ax.set_zlim(c[2]-r,c[2]+r)
    ax.set_box_aspect((1,1,1));ax.view_init(elev=el,azim=az);ax.set_axis_off();ax.set_title(t,fontsize=10)
fig=plt.figure(figsize=(12,5.2),facecolor="white")
draw(fig.add_subplot(1,2,1,projection="3d"),"public/examples/corner-saloon-kirigami-flat.stl","flat (print): pinched-hex tiles",60,-78,[0.62,0.47,0.33])
draw(fig.add_subplot(1,2,2,projection="3d"),"public/examples/corner-saloon-kirigami.stl","folded body (corner saloon)",14,48,[0.62,0.47,0.33])
fig.suptitle("corner-saloon — kirigamized (same printed joinery as house-door)",fontsize=12,y=0.96)
fig.tight_layout();fig.savefig("/tmp/corner-kiri.png",dpi=130,facecolor="white");print("ok")
