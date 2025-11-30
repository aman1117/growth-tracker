const API_URL = 'https://northern-mariellen-aman1117-e5652442.koyeb.app';

export const api = {
    async get(endpoint: string) {
        const token = localStorage.getItem('access_token');
        const headers: HeadersInit = {
            'Content-Type': 'application/json',
        };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const res = await fetch(`${API_URL}${endpoint}`, {
            method: 'GET',
            headers,
        });
        return res.json();
    },

    async post(endpoint: string, body: any) {
        const token = localStorage.getItem('access_token');
        const headers: HeadersInit = {
            'Content-Type': 'application/json',
        };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const res = await fetch(`${API_URL}${endpoint}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        return res.json();
    }
};
