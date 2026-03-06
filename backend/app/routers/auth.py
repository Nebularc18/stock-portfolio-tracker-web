"""Authentication and account endpoints."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.main import get_db, User, hash_password

router = APIRouter()


class LoginRequest(BaseModel):
    username: str = Field(min_length=2, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class RegisterRequest(BaseModel):
    username: str = Field(min_length=2, max_length=64)
    password: str = Field(min_length=6, max_length=256)


class AuthResponse(BaseModel):
    id: int
    username: str
    is_guest: bool


@router.post("/login", response_model=AuthResponse)
def login(data: LoginRequest, db: Session = Depends(get_db)):
    username = data.username.strip()
    user = db.query(User).filter(User.username == username).first()
    if not user or user.password_hash != hash_password(data.password):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    return AuthResponse(id=user.id, username=user.username, is_guest=user.is_guest)


@router.post("/register", response_model=AuthResponse)
def register(data: RegisterRequest, db: Session = Depends(get_db)):
    username = data.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")

    existing = db.query(User).filter(User.username == username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists")

    user = User(username=username, password_hash=hash_password(data.password), is_guest=False)
    db.add(user)
    db.commit()
    db.refresh(user)
    return AuthResponse(id=user.id, username=user.username, is_guest=user.is_guest)


@router.post("/guest", response_model=AuthResponse)
def guest_login(db: Session = Depends(get_db)):
    user = db.query(User).filter(User.is_guest.is_(True)).order_by(User.id.asc()).first()
    if not user:
        raise HTTPException(status_code=500, detail="Guest user not configured")
    return AuthResponse(id=user.id, username=user.username, is_guest=user.is_guest)


@router.get("/users", response_model=list[AuthResponse])
def list_users(db: Session = Depends(get_db)):
    users = db.query(User).order_by(User.username.asc()).all()
    return [AuthResponse(id=u.id, username=u.username, is_guest=u.is_guest) for u in users]
