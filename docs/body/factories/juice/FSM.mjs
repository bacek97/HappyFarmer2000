
// let isMoving = false;

// function initMap(el) {
//   let startX, startY;

//   el.onpointerdown = (e) => {
//     if (e.pointerType === 'mouse' && e.button !== 0) return;
//     isMoving = false;
//     [startX, startY] = [e.pageX, e.pageY];
//     window.addEventListener('pointermove', onMove);
//     window.addEventListener('pointerup', onUp);
//   };

//   function onUp() {
//     window.removeEventListener('pointermove', onMove);
//     window.removeEventListener('pointerup', onUp);
//   }

//   function onMove(e) {
//     const [dx, dy] = [e.pageX - startX, e.pageY - startY];
//     if (Math.abs(dx) > 5 || Math.abs(dy) > 5) isMoving = true;
//     el.scrollLeft -= e.movementX;
//     el.scrollTop -= e.movementY;
//   }
// }


import { GameModal } from '../../0-ui/0-modal/FSM.mjs';


class UiShop extends HTMLElement {
  static #stylesInjected = false;
  constructor() {
    super();
  }

  fsm = {
    assd: () => { console.log(this); }

  }

  connectedCallback() {
    if (!UiShop.#stylesInjected) {
      // this.id = 'map-viewport';
      // this.classList.add('map-container');
      UiShop.#stylesInjected = true;
      document.head.appendChild(Object.assign(document.createElement('style'), {
        textContent: `

        ` }));
    }

    // this.innerHTML = `
    //             <div onclick="openModal('modal-shop')">Магазин</div>
    //     `;
    this.append(Object.assign(document.createElement('button'), {
      textContent: 'Juice',
      onclick: () => {
        modals['modal-shop'].open();
      }
    }));
    this.style.position = 'absolute';
    this.style.top = '400px';
    this.style.left = '300px';

    // function openModal(id) {
    //   if (isMoving) return;
    //   if (modals[id]) {
    //     modals[id].open();
    //   }
    // }

    // this.setAttribute('role', 'region');
    // initMap(this);


    const modals = {};

    modals['modal-shop'] = new GameModal({
      parent: this,
      id: 'modal-shop',
      title: 'Магазин',
      tabs: [
        {
          name: 'Семена',
          content: `
                        <p><strong>Раздел: Семена</strong></p>
                        <p>Здесь вы можете купить лучшие семена для вашей фермы. Пшеница, кукуруза, морковь и многое другое.</p>
                        <button class="btn-action">Купить семена</button>
                    `
        },
        {
          name: 'Цветы',
          content: `
                        <p><strong>Раздел: Цветы</strong></p>
                        <p>Украсьте свой участок прекрасными цветами. <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            <br />
                            Розы, тюльпаны, ромашки.</p>
                        <button class="btn-action">Выбрать цветы</button>
                    `
        },
        {
          name: 'Хозтовары',
          content: `
                        <p><strong>Раздел: Хозтовары</strong></p>
                        <p>Инструменты, удобрения, лейки и все необходимое для работы.</p>
                        <button class="btn-action">Смотреть товары</button>
                    `
        },
        {
          name: 'Животные',
          content: `
                        <p><strong>Раздел: Животные</strong></p>
                        <p>Заведите себе питомцев! Коровы, овцы, куры и даже собака.</p>
                        <button class="btn-action">Питомник</button>
                    `
        },
        {
          name: 'Декор',
          content: `
                        <p><strong>Раздел: Декор</strong></p>
                        <p>Заборы, дорожки, фонтаны и статуи для красоты.</p>
                        <button class="btn-action">Каталог декора</button>
                    `
        },
        {
          name: 'Наборы',
          content: `
                        <p><strong>Раздел: Наборы</strong></p>
                        <p>Выгодные комплекты для начинающих и профессионалов.</p>
                        <button class="btn-action">Спецпредложения</button>
                    `
        }
      ]
    });
  }

}

customElements.define('factory-juice', UiShop);




// Инициализация при загрузке модуля
document.querySelector('.map-content').append(new UiShop());
