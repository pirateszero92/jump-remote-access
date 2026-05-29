const form = document.getElementById('login-form');
const btn = document.getElementById('login-btn');
const errorEl = document.getElementById('login-error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const user = document.getElementById('user').value;
  const pass = document.getElementById('pass').value;

  errorEl.style.display = 'none';
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Signing In...';

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, pass }),
    });

    const data = await response.json();

    if (response.ok) {
      localStorage.setItem('jump:last-activity', String(Date.now()));
      window.location.href = '/';
    } else {
      throw new Error(data.error || 'Login failed');
    }
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.style.display = 'block';
    btn.disabled = false;
    btn.innerHTML = 'Sign In <i class="fa-solid fa-arrow-right-to-bracket"></i>';
  }
});
