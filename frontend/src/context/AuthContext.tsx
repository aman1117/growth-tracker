import React, { createContext, useContext, useState, useEffect } from 'react';
import { STORAGE_KEYS } from '../constants/storage';


interface AuthContextType {
    user: { username: string; id: number; profilePic?: string | null; bio?: string | null } | null;
    login: (token: string, username: string, userId: number, profilePic?: string | null, bio?: string | null) => void;
    logout: () => void;
    updateUsername: (newUsername: string) => void;
    updateProfilePic: (url: string | null) => void;
    updateBio: (bio: string | null) => void;
    isAuthenticated: boolean;
    isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [user, setUser] = useState<{ username: string; id: number; profilePic?: string | null; bio?: string | null } | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const token = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
        const username = localStorage.getItem(STORAGE_KEYS.USERNAME);
        const userId = localStorage.getItem(STORAGE_KEYS.USER_ID);
        const profilePic = localStorage.getItem(STORAGE_KEYS.PROFILE_PIC);
        const bio = localStorage.getItem(STORAGE_KEYS.BIO);

        if (token && username && userId) {
            setUser({ username, id: parseInt(userId), profilePic: profilePic || null, bio: bio || null });
        }
        setIsLoading(false);
    }, []);

    const login = (token: string, username: string, userId: number, profilePic?: string | null, bio?: string | null) => {
        localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, token);
        localStorage.setItem(STORAGE_KEYS.USERNAME, username);
        localStorage.setItem(STORAGE_KEYS.USER_ID, userId.toString());
        if (profilePic) {
            localStorage.setItem(STORAGE_KEYS.PROFILE_PIC, profilePic);
        } else {
            localStorage.removeItem(STORAGE_KEYS.PROFILE_PIC);
        }
        if (bio) {
            localStorage.setItem(STORAGE_KEYS.BIO, bio);
        } else {
            localStorage.removeItem(STORAGE_KEYS.BIO);
        }
        setUser({ username, id: userId, profilePic, bio });
    };

    const logout = () => {
        localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
        localStorage.removeItem(STORAGE_KEYS.USERNAME);
        localStorage.removeItem(STORAGE_KEYS.USER_ID);
        localStorage.removeItem(STORAGE_KEYS.PROFILE_PIC);
        localStorage.removeItem(STORAGE_KEYS.BIO);
        setUser(null);
    };

    const updateUsername = (newUsername: string) => {
        localStorage.setItem(STORAGE_KEYS.USERNAME, newUsername);
        if (user) {
            setUser({ ...user, username: newUsername });
        }
    };

    const updateProfilePic = (url: string | null) => {
        if (url) {
            localStorage.setItem(STORAGE_KEYS.PROFILE_PIC, url);
        } else {
            localStorage.removeItem(STORAGE_KEYS.PROFILE_PIC);
        }
        if (user) {
            setUser({ ...user, profilePic: url });
        }
    };

    const updateBio = (bio: string | null) => {
        if (bio) {
            localStorage.setItem(STORAGE_KEYS.BIO, bio);
        } else {
            localStorage.removeItem(STORAGE_KEYS.BIO);
        }
        if (user) {
            setUser({ ...user, bio });
        }
    };

    return (
        <AuthContext.Provider value={{ user, login, logout, updateUsername, updateProfilePic, updateBio, isAuthenticated: !!user, isLoading }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
};
