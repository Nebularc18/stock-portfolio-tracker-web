"""Authentication and account endpoints."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.main import get_db, User, hash_password, verify_password, create_access_token, get_current_user

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
    token: str | None = None


@router.post("/login", response_model=AuthResponse)
def login(data: LoginRequest, db: Session = Depends(get_db)):
    username = data.username.strip()
    user = db.query(User).filter(User.username == username).first()
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    token = create_access_token(user.id)
    return AuthResponse(id=user.id, username=user.username, is_guest=user.is_guest, token=token)


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
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail="Username already exists") from exc
    db.refresh(user)
    token = create_access_token(user.id)
    return AuthResponse(id=user.id, username=user.username, is_guest=user.is_guest, token=token)


@router.post("/guest", response_model=AuthResponse)
def guest_login(db: Session = Depends(get_db)):
    user = db.query(User).filter(User.is_guest.is_(True)).order_by(User.id.asc()).first()
    if not user:
        raise HTTPException(status_code=500, detail="Guest user not configured")
    token = create_access_token(user.id)
    return AuthResponse(id=user.id, username=user.username, is_guest=user.is_guest, token=token)


@router.get("/users", response_model=AuthResponse)
def list_users(current_user: User = Depends(get_current_user)):
    return AuthResponse(
        id=current_user.id,
        username=current_user.username,
        is_guest=current_user.is_guest,
    )
